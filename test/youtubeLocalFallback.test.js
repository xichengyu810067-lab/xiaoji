const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  createYoutubeFallbackRuntime,
  logYouTubeLocalFailure,
  runYouTubeLocalRuntimeStage,
  shouldUseLocalYouTubeFallback,
  waitForSustainedLocalPlayback,
} = require('../src/services/musicService');
const {
  YouTubeLocalSourceError,
  createAnonymousInnertube,
  createRangedMediaStream,
  createTrustedYouTubeDurationEvidence,
  extractStrictYouTubeVideoId,
  getYouTubeLocalDiagnostics,
  isAllowedYouTubeMediaUrl,
  isYouTubeLocalError,
  loadAnonymousYouTubeAudio,
  normalizeDurationSeconds,
  youtubeMediaChunkBytes,
  youtubeSourceMaxDurationSeconds,
  youtubeSourceMaxBytes,
} = require('../src/services/youtubeLocalSource');
const logger = require('../src/utils/logger');

function createWebStream(chunks = [new Uint8Array([1, 2, 3])]) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function createRangeResponse({
  status = 206,
  contentRange = 'bytes 0-2/3',
  contentLength = '3',
  chunks = [new Uint8Array([1, 2, 3])],
  url = 'https://rr1---sn.example.googlevideo.com/videoplayback',
} = {}) {
  const headers = new Headers();
  if (contentRange !== null) headers.set('content-range', contentRange);
  if (contentLength !== null) headers.set('content-length', contentLength);
  return {
    status,
    url,
    headers,
    body: createWebStream(chunks),
  };
}

function createAudioStreamingData(format = { has_audio: true }) {
  return {
    formats: [],
    adaptive_formats: [format],
  };
}

function createMetadataClient(overrides = {}, { onChooseFormat = () => {} } = {}) {
  const player = { synthetic: true };
  return async () => {
    const format = {
      has_audio: true,
      content_length: 3,
      decipher: async (receivedPlayer) => {
        assert.equal(receivedPlayer, player);
        return 'https://rr1---sn.example.googlevideo.com/videoplayback';
      },
    };
    return {
      session: { player },
      getBasicInfo: async () => ({
        basic_info: {
          id: 'dQw4w9WgXcQ',
          title: 'Synthetic metadata',
          duration: 301,
          is_live: false,
          is_live_content: false,
          ...overrides,
        },
        streaming_data: createAudioStreamingData(format),
        chooseFormat: () => {
          onChooseFormat();
          return format;
        },
      }),
    };
  };
}

function createDurationEvidence(overrides = {}) {
  return createTrustedYouTubeDurationEvidence({
    videoId: 'dQw4w9WgXcQ',
    sourceName: 'youtube',
    identifier: 'dQw4w9WgXcQ',
    uri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    isStream: false,
    requestId: 'request-duration',
    encodedTrack: 'encoded-duration-track',
    durationMs: 273_000,
    ...overrides,
  });
}

async function assertRangedMediaRejects(response, expectedCode) {
  const stream = createRangedMediaStream(
    'https://rr1---sn.example.googlevideo.com/videoplayback',
    3,
    {
      chunkBytes: 3,
      mediaFetch: async (_mediaUrl, options) => {
        assert.equal(options.redirect, 'error');
        return response;
      },
    }
  );
  await assert.rejects(stream.getReader().read(), (error) => error.code === expectedCode);
}

function createPcmWav({ durationMs = 1_000, sampleRate = 48_000, frequency = 440 } = {}) {
  const sampleCount = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 8_000);
    wav.writeInt16LE(sample, 44 + index * 2);
  }
  return wav;
}

function createReadinessHarness() {
  return {
    resource: { playbackDuration: 0 },
    runtime: {
      activity: { inputBytes: 0, outputBytes: 0 },
      cleaned: false,
      sourceStream: new EventEmitter(),
      outputStream: new EventEmitter(),
      subprocess: new EventEmitter(),
    },
    state: { player: new EventEmitter() },
  };
}

test('youtubei.js is exact-pinned and loaded only through dynamic import', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'));
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'youtubeLocalSource.js'),
    'utf8'
  );

  assert.equal(packageJson.dependencies['youtubei.js'], '18.0.0');
  assert.equal(packageJson.engines.node, '>=20.18.1');
  assert.equal(lock.packages['node_modules/youtubei.js'].version, '18.0.0');
  assert.match(source, /import\('youtubei\.js'\)/);
  assert.doesNotMatch(source, /require\(['"]youtubei\.js['"]\)/);
});

test('strict YouTube input accepts only a video id or supported video URL', () => {
  assert.equal(extractStrictYouTubeVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractStrictYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractStrictYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractStrictYouTubeVideoId('https://youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractStrictYouTubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(extractStrictYouTubeVideoId('https://youtu.be/not-valid'), null);
  assert.equal(extractStrictYouTubeVideoId('ytsearch:dQw4w9WgXcQ'), null);
});

test('duration normalization accepts only positive integer seconds without unit guessing', () => {
  for (const [value, expected] of [
    [301, 301],
    [7_200, 7_200],
    ['301', 301],
    ['007200', 7_200],
    [301_000, 301_000],
    ['301000', 301_000],
  ]) {
    assert.equal(normalizeDurationSeconds(value), expected);
  }

  for (const value of [
    undefined,
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0,
    -1,
    1.5,
    '',
    ' 301',
    '301 ',
    '301.0',
    '301s',
    '+301',
    '-301',
  ]) {
    assert.equal(normalizeDurationSeconds(value), null);
  }
});

test('media fetch accepts only HTTPS googlevideo hosts', () => {
  assert.equal(isAllowedYouTubeMediaUrl('https://rr1---sn.example.googlevideo.com/videoplayback'), true);
  assert.equal(isAllowedYouTubeMediaUrl('http://rr1---sn.example.googlevideo.com/videoplayback'), false);
  assert.equal(isAllowedYouTubeMediaUrl('https://googlevideo.com.evil.example/videoplayback'), false);
  assert.equal(isAllowedYouTubeMediaUrl('https://example.com/videoplayback'), false);
});

test('ranged media stream rejects oversized content before fetching', () => {
  assert.throws(
    () =>
      createRangedMediaStream(
        'https://rr1---sn.example.googlevideo.com/videoplayback',
        youtubeSourceMaxBytes + 1
      ),
    (error) => error.code === 'youtube_local_media_invalid'
  );
});

test('default ranged media requests strict consecutive 64 KiB chunks', async () => {
  const totalBytes = youtubeMediaChunkBytes * 2 + 1;
  const requestedRanges = [];
  const stream = createRangedMediaStream(
    'https://rr1---sn.example.googlevideo.com/videoplayback',
    totalBytes,
    {
      mediaFetch: async (_mediaUrl, options) => {
        const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
        assert.ok(match);
        const start = Number(match[1]);
        const end = Number(match[2]);
        const length = end - start + 1;
        requestedRanges.push(options.headers.Range);
        return createRangeResponse({
          contentRange: `bytes ${start}-${end}/${totalBytes}`,
          contentLength: String(length),
          chunks: [new Uint8Array(length)],
        });
      },
    }
  );

  let receivedBytes = 0;
  for await (const chunk of stream) receivedBytes += chunk.byteLength;

  assert.equal(youtubeMediaChunkBytes, 65_536);
  assert.equal(receivedBytes, totalBytes);
  assert.deepEqual(requestedRanges, [
    'bytes=0-65535',
    'bytes=65536-131071',
    'bytes=131072-131072',
  ]);
});

test('ranged media stream rejects redirects or a private final response URL', async () => {
  await assertRangedMediaRejects(
    createRangeResponse({
      status: 302,
      contentRange: null,
      contentLength: null,
      url: 'https://rr1---sn.example.googlevideo.com/videoplayback',
    }),
    'youtube_local_stream_invalid'
  );
  await assertRangedMediaRejects(
    createRangeResponse({ url: 'http://127.0.0.1/private-media' }),
    'youtube_local_media_host_rejected'
  );
});

test('ranged media stream rejects 200 and mismatched Content-Range', async () => {
  await assertRangedMediaRejects(createRangeResponse({ status: 200 }), 'youtube_local_stream_invalid');
  for (const contentRange of ['bytes 1-2/3', 'bytes 0-1/3', 'bytes 0-2/4', 'invalid']) {
    await assertRangedMediaRejects(
      createRangeResponse({ contentRange }),
      'youtube_local_range_invalid'
    );
  }
});

test('ranged media stream rejects oversized Content-Length and actual body bytes', async () => {
  await assertRangedMediaRejects(
    createRangeResponse({ contentLength: '4' }),
    'youtube_local_length_invalid'
  );
  await assertRangedMediaRejects(
    createRangeResponse({
      contentLength: null,
      chunks: [new Uint8Array([1, 2, 3, 4])],
    }),
    'youtube_local_length_invalid'
  );
  await assertRangedMediaRejects(
    createRangeResponse({
      contentLength: null,
      chunks: [new Uint8Array([1, 2])],
    }),
    'youtube_local_length_invalid'
  );
});

test('ranged media stream classifies generic fetch failures and preserves its timeout code', async () => {
  const failedFetchStream = createRangedMediaStream(
    'https://rr1---sn.example.googlevideo.com/videoplayback',
    3,
    {
      mediaFetch: async () => {
        throw new Error('synthetic private fetch internals');
      },
    }
  );
  await assert.rejects(
    failedFetchStream.getReader().read(),
    (error) => error.code === 'youtube_local_stream_failed'
  );

  const stalledFetchStream = createRangedMediaStream(
    'https://rr1---sn.example.googlevideo.com/videoplayback',
    3,
    {
      mediaFetch: () => new Promise(() => {}),
      requestTimeoutMs: 20,
    }
  );
  await assert.rejects(
    stalledFetchStream.getReader().read(),
    (error) => error.code === 'youtube_local_stream_timeout'
  );
});

test('anonymous youtubei session receives no app-owned account or visitor identity', async () => {
  let capturedOptions;
  const client = await createAnonymousInnertube({
    importYoutubei: async () => ({
      Innertube: {
        create: async (options) => {
          capturedOptions = options;
          return { anonymous: true };
        },
      },
    }),
    fetchImpl: async () => new Response('ok'),
  });

  assert.deepEqual(client, { anonymous: true });
  assert.equal(capturedOptions.enable_session_cache, false);
  assert.equal(Object.hasOwn(capturedOptions, 'generate_session_locally'), false);
  assert.equal(typeof capturedOptions.fetch, 'function');
  for (const forbiddenKey of ['cookie', 'oauth', 'po_token', 'visitor_data']) {
    assert.equal(Object.hasOwn(capturedOptions, forbiddenKey), false);
  }
});

test('anonymous source returns an in-memory audio stream without a URL', async () => {
  const player = { synthetic: true };
  const format = {
    has_audio: true,
    content_length: 3,
    decipher: async (receivedPlayer) => {
      assert.equal(receivedPlayer, player);
      return 'https://rr1---sn.example.googlevideo.com/videoplayback';
    },
  };
  const result = await loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
    clientFactory: async () => ({
      session: { player },
      getBasicInfo: async (videoId, options) => {
        assert.equal(videoId, 'dQw4w9WgXcQ');
        assert.deepEqual(options, { client: 'IOS' });
        return {
          basic_info: {
            id: 'dQw4w9WgXcQ',
            title: 'Synthetic @everyone title',
            duration: '7200',
            is_live: false,
            is_live_content: false,
          },
          streaming_data: createAudioStreamingData(format),
          chooseFormat: (formatOptions) => {
            assert.deepEqual(formatOptions, { type: 'audio', quality: 'best', format: 'any' });
            return format;
          },
        };
      },
    }),
    mediaFetch: async (mediaUrl, options) => {
      assert.equal(mediaUrl, 'https://rr1---sn.example.googlevideo.com/videoplayback');
      assert.deepEqual(options, {
        headers: { Range: 'bytes=0-2' },
        redirect: 'error',
        signal: options.signal,
      });
      return createRangeResponse({ chunks: [new Uint8Array([1, 2, 3])] });
    },
  });

  const reader = result.webStream.getReader();
  const firstChunk = await reader.read();
  assert.equal(firstChunk.done, false);
  assert.deepEqual([...firstChunk.value], [1, 2, 3]);
  await reader.cancel();
  assert.deepEqual(result.track, {
    title: 'Synthetic ＠everyone title',
    duration: 7_200,
    source: 'youtube-local',
  });
  assert.equal(Object.hasOwn(result.track, 'url'), false);
});

test('anonymous source falls back from metadata-only IOS to validated ANDROID audio', async () => {
  const requestedClients = [];
  const format = {
    has_audio: true,
    content_length: 3,
    decipher: async () => 'https://rr1---sn.example.googlevideo.com/videoplayback',
  };
  const result = await loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
    clientFactory: async () => ({
      session: { player: { synthetic: true } },
      getBasicInfo: async (videoId, options) => {
        assert.equal(videoId, 'dQw4w9WgXcQ');
        assert.deepEqual(Object.keys(options), ['client']);
        requestedClients.push(options.client);
        const basic_info = {
          id: 'dQw4w9WgXcQ',
          title: `${options.client} synthetic metadata`,
          duration: options.client === 'IOS' ? 301 : 302,
          is_live: false,
          is_live_content: false,
        };
        if (options.client === 'IOS') return { basic_info };
        return {
          basic_info,
          streaming_data: createAudioStreamingData(format),
          chooseFormat: () => format,
        };
      },
    }),
  });

  assert.deepEqual(requestedClients, ['IOS', 'ANDROID']);
  assert.deepEqual(result.track, {
    title: 'ANDROID synthetic metadata',
    duration: 302,
    source: 'youtube-local',
  });
  await result.webStream.cancel();
});

test('anonymous source does not request ANDROID when IOS has validated audio', async () => {
  const requestedClients = [];
  const clientFactory = createMetadataClient();
  const createdClient = await clientFactory();
  const originalGetBasicInfo = createdClient.getBasicInfo;
  createdClient.getBasicInfo = async (videoId, options) => {
    requestedClients.push(options.client);
    return originalGetBasicInfo(videoId, options);
  };

  const result = await loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
    clientFactory: async () => createdClient,
  });
  assert.deepEqual(requestedClients, ['IOS']);
  await result.webStream.cancel();
});

test('anonymous source fails closed when both anonymous clients lack audio', async () => {
  const requestedClients = [];
  await assert.rejects(
    loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
      clientFactory: async () => ({
        getBasicInfo: async (_videoId, options) => {
          requestedClients.push(options.client);
          return {
            basic_info: {
              id: 'dQw4w9WgXcQ',
              duration: 301,
              is_live: false,
              is_live_content: false,
            },
            streaming_data: { formats: [], adaptive_formats: [] },
          };
        },
      }),
    }),
    (error) =>
      isYouTubeLocalError(error) &&
      error.code === 'youtube_local_format_selection_failed' &&
      !/url|header|body|secret/i.test(error.message)
  );
  assert.deepEqual(requestedClients, ['IOS', 'ANDROID']);
});

test('anonymous source exposes only bounded stage diagnostics for failed client selection', async () => {
  let failure;
  try {
    await loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
      clientFactory: async () => ({
        getBasicInfo: async (_videoId, options) => ({
          basic_info: {
            id: 'dQw4w9WgXcQ',
            title: `private ${options.client} metadata`,
            duration: 301,
            is_live: false,
            is_live_content: false,
          },
          streaming_data: { formats: [], adaptive_formats: [] },
        }),
      }),
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(failure?.code, 'youtube_local_format_selection_failed');
  const diagnostics = getYouTubeLocalDiagnostics(failure);
  assert.equal(diagnostics.length, 2);
  assert.ok(Object.isFrozen(diagnostics));
  assert.ok(diagnostics.every(Object.isFrozen));
  assert.deepEqual(diagnostics, ['IOS', 'ANDROID'].map((client) => ({
    client,
    stage: 'no-audio',
    metadataReceived: true,
    identityValid: true,
    nonLive: true,
    durationValid: true,
    streamingDataPresent: true,
    formatCount: 0,
    audioFormatCount: 0,
    chooseFormatSucceeded: false,
  })));
  assert.doesNotMatch(JSON.stringify(diagnostics), /private|title|url|header|body|encoded|requester|secret/i);

  const warnings = [];
  const originalWarn = logger.warn;
  logger.warn = (message) => warnings.push(message);
  try {
    logYouTubeLocalFailure('guild/diagnostic', failure);
  } finally {
    logger.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /guildId=guilddiagnostic code=youtube_local_format_selection_failed diagnostics=\[/);
  assert.doesNotMatch(warnings[0], /private|title|url|header|body|encoded|requester|secret/i);

  for (const fixture of [
    {
      expectedStage: 'identity',
      info: {
        basic_info: { id: 'aaaaaaaaaaa', duration: 301, is_live: false, is_live_content: false },
      },
    },
    {
      expectedStage: 'choose-format',
      info: (() => {
        const format = { has_audio: true, decipher: async () => 'https://rr1---sn.example.googlevideo.com/videoplayback' };
        return {
          basic_info: { id: 'dQw4w9WgXcQ', duration: 301, is_live: false, is_live_content: false },
          streaming_data: createAudioStreamingData(format),
          chooseFormat: () => { throw new Error('private selection detail'); },
        };
      })(),
    },
    {
      expectedStage: 'decipher',
      info: (() => {
        const format = {
          has_audio: true,
          decipher: async () => { throw new Error('private decipher detail'); },
        };
        return {
          basic_info: { id: 'dQw4w9WgXcQ', duration: 301, is_live: false, is_live_content: false },
          streaming_data: createAudioStreamingData(format),
          chooseFormat: () => format,
        };
      })(),
    },
  ]) {
    let stageFailure;
    try {
      await loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
        clientFactory: async () => ({ getBasicInfo: async () => fixture.info }),
      });
    } catch (error) {
      stageFailure = error;
    }
    assert.equal(getYouTubeLocalDiagnostics(stageFailure)[0].stage, fixture.expectedStage);
    assert.doesNotMatch(JSON.stringify(getYouTubeLocalDiagnostics(stageFailure)), /private|url|header|body|secret/i);
  }
});

test('ANDROID fallback independently rejects invalid identity, live, duration, and format data', async () => {
  const baseInfo = {
    id: 'dQw4w9WgXcQ',
    duration: 301,
    is_live: false,
    is_live_content: false,
  };
  const cases = [
    [{ basic_info: { ...baseInfo, id: 'aaaaaaaaaaa' } }, 'youtube_local_metadata_id_mismatch'],
    [{ basic_info: { ...baseInfo, id: { malformed: true } } }, 'youtube_local_metadata_id_mismatch'],
    [{ basic_info: { ...baseInfo, is_live: true } }, 'youtube_local_live_rejected'],
    [{ basic_info: { ...baseInfo, duration: undefined } }, 'youtube_local_duration_invalid'],
    [{ basic_info: baseInfo, streaming_data: { formats: {}, adaptive_formats: [] } }, 'youtube_local_format_selection_failed'],
    [{ basic_info: baseInfo, streaming_data: createAudioStreamingData({ has_audio: false }) }, 'youtube_local_format_selection_failed'],
  ];

  for (const [androidInfo, expectedCode] of cases) {
    const requestedClients = [];
    await assert.rejects(
      loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
        clientFactory: async () => ({
          getBasicInfo: async (_videoId, options) => {
            requestedClients.push(options.client);
            if (options.client === 'IOS') {
              return { basic_info: baseInfo };
            }
            return androidInfo;
          },
        }),
      }),
      (error) => error.code === expectedCode
    );
    assert.deepEqual(requestedClients, ['IOS', 'ANDROID']);
  }
});

test('ANDROID fallback maps upstream details to an allowlisted non-secret error', async () => {
  const sensitiveDetails =
    'https://private.example token=secret Cookie=session header=Bearer body=private error=upstream';
  await assert.rejects(
    loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
      clientFactory: async () => ({
        getBasicInfo: async (_videoId, options) => {
          assert.deepEqual(Object.keys(options), ['client']);
          if (options.client === 'IOS') {
            return {
              basic_info: {
                id: 'dQw4w9WgXcQ',
                duration: 301,
                is_live: false,
                is_live_content: false,
              },
            };
          }
          throw new Error(sensitiveDetails);
        },
      }),
    }),
    (error) =>
      isYouTubeLocalError(error) &&
      error.code === 'youtube_local_info_failed' &&
      !error.message.includes(sensitiveDetails) &&
      !/https?:|token|secret|cookie|header|body|error/i.test(error.message)
  );
});

test('anonymous source accepts missing or matching metadata ids without inventing one', async () => {
  for (const id of [undefined, null, '', '   ', 'dQw4w9WgXcQ']) {
    const result = await loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
      clientFactory: createMetadataClient({ id }),
    });

    assert.deepEqual(result.track, {
      title: 'Synthetic metadata',
      duration: 301,
      source: 'youtube-local',
    });
    assert.equal(Object.hasOwn(result.track, 'id'), false);
    await result.webStream.cancel();
  }
});

test('anonymous source rejects different strings and every malformed non-string metadata id', async () => {
  for (const id of ['aaaaaaaaaaa', 123, {}, [], false, Symbol('synthetic')]) {
    let chooseFormatCalls = 0;
    let mediaFetchCalls = 0;

    await assert.rejects(
      loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
        clientFactory: createMetadataClient(
          { id },
          { onChooseFormat: () => { chooseFormatCalls += 1; } }
        ),
        mediaFetch: async () => {
          mediaFetchCalls += 1;
          throw new Error('media fetch must not be reached');
        },
      }),
      (error) => error.code === 'youtube_local_metadata_id_mismatch'
    );

    assert.equal(chooseFormatCalls, 0);
    assert.equal(mediaFetchCalls, 0);
  }
});

test('anonymous source preserves live rejection codes', async () => {
  for (const overrides of [{ is_live: true }, { is_live_content: true }]) {
    await assert.rejects(
      loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
        clientFactory: createMetadataClient(overrides),
      }),
      (error) => error.code === 'youtube_local_live_rejected'
    );
  }
});

test('anonymous source distinguishes invalid and overlong duration seconds', async () => {
  for (const duration of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, '301ms']) {
    await assert.rejects(
      loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
        clientFactory: createMetadataClient({ duration }),
      }),
      (error) => error.code === 'youtube_local_duration_invalid'
    );
  }

  for (const duration of [youtubeSourceMaxDurationSeconds + 1, 301_000, '301000']) {
    await assert.rejects(
      loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
        clientFactory: createMetadataClient({ duration }),
      }),
      (error) => error.code === 'youtube_local_duration_overlong'
    );
  }
});

test('anonymous source classifies session and info failures without exposing upstream details', async () => {
  for (const clientFactory of [
    () => { throw new Error('synthetic session URL https://private.example/session'); },
    async () => { throw new Error('synthetic rejected session secret'); },
  ]) {
    await assert.rejects(
      loadAnonymousYouTubeAudio('dQw4w9WgXcQ', { clientFactory }),
      (error) =>
        error.code === 'youtube_local_session_failed' &&
        !/private|secret|https?:/i.test(error.message)
    );
  }

  for (const getBasicInfo of [
    () => { throw new Error('synthetic info URL https://private.example/info'); },
    async () => { throw new Error('synthetic rejected info secret'); },
  ]) {
    await assert.rejects(
      loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
        clientFactory: async () => ({ getBasicInfo }),
      }),
      (error) =>
        error.code === 'youtube_local_info_failed' &&
        !/private|secret|https?:/i.test(error.message)
    );
  }

  await assert.rejects(
    loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
      clientFactory: async () => ({
        getBasicInfo: async () => {
          throw new YouTubeLocalSourceError('youtube_local_info_timeout');
        },
      }),
    }),
    (error) => error.code === 'youtube_local_info_timeout'
  );
});

test('anonymous source classifies format selection failures before media fetch', async () => {
  const validBasicInfo = {
    id: 'dQw4w9WgXcQ',
    title: 'Synthetic format test',
    duration: 301,
    is_live: false,
    is_live_content: false,
  };
  const audioStreamingData = createAudioStreamingData();
  const infoResults = [
    { basic_info: validBasicInfo, streaming_data: audioStreamingData },
    { basic_info: validBasicInfo, streaming_data: audioStreamingData, chooseFormat: () => { throw new Error('synthetic selection internals'); } },
    { basic_info: validBasicInfo, streaming_data: audioStreamingData, chooseFormat: () => null },
    { basic_info: validBasicInfo, streaming_data: audioStreamingData, chooseFormat: () => ({ has_audio: true, decipher: null }) },
  ];

  for (const info of infoResults) {
    let mediaFetchCalls = 0;
    await assert.rejects(
      loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
        clientFactory: async () => ({ getBasicInfo: async () => info }),
        mediaFetch: async () => {
          mediaFetchCalls += 1;
          throw new Error('media fetch must not be reached');
        },
      }),
      (error) => error.code === 'youtube_local_format_selection_failed'
    );
    assert.equal(mediaFetchCalls, 0);
  }

  await assert.rejects(
    loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
      clientFactory: async () => ({
        getBasicInfo: async () => ({
          basic_info: validBasicInfo,
          streaming_data: audioStreamingData,
          chooseFormat: () => {
            throw new YouTubeLocalSourceError('youtube_local_media_invalid');
          },
        }),
      }),
    }),
    (error) => error.code === 'youtube_local_media_invalid'
  );
});

test('anonymous source classifies decipher failures while preserving timeout and host codes', async () => {
  const createClientFactory = (decipher) => async () => {
    const format = { has_audio: true, content_length: 3, decipher };
    return {
      session: { player: { synthetic: true } },
      getBasicInfo: async () => ({
        basic_info: {
          id: 'dQw4w9WgXcQ',
          title: 'Synthetic decipher test',
          duration: 301,
          is_live: false,
          is_live_content: false,
        },
        streaming_data: createAudioStreamingData(format),
        chooseFormat: () => format,
      }),
    };
  };

  for (const decipher of [
    () => { throw new Error('synthetic decipher URL https://private.example/media'); },
    async () => { throw new Error('synthetic rejected decipher secret'); },
  ]) {
    let mediaFetchCalls = 0;
    await assert.rejects(
      loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
        clientFactory: createClientFactory(decipher),
        mediaFetch: async () => {
          mediaFetchCalls += 1;
          throw new Error('media fetch must not be reached');
        },
      }),
      (error) =>
        error.code === 'youtube_local_format_decipher_failed' &&
        !/private|secret|https?:/i.test(error.message)
    );
    assert.equal(mediaFetchCalls, 0);
  }

  await assert.rejects(
    loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
      clientFactory: createClientFactory(() => new Promise(() => {})),
      requestTimeoutMs: 20,
    }),
    (error) => error.code === 'youtube_local_format_timeout'
  );
  await assert.rejects(
    loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
      clientFactory: createClientFactory(async () => 'https://example.com/media'),
    }),
    (error) => error.code === 'youtube_local_media_host_rejected'
  );
});

test('anonymous source classifies unknown stream creation errors and preserves media validation', async () => {
  let mediaFetchCalls = 0;
  const createClientFactory = (contentLength) => async () => {
    const format = {
      has_audio: true,
      get content_length() {
        if (contentLength instanceof Error) throw contentLength;
        return contentLength;
      },
      decipher: async () => 'https://rr1---sn.example.googlevideo.com/videoplayback',
    };
    return {
      session: { player: { synthetic: true } },
      getBasicInfo: async () => ({
        basic_info: {
          id: 'dQw4w9WgXcQ',
          duration: 301,
          is_live: false,
          is_live_content: false,
        },
        streaming_data: createAudioStreamingData(format),
        chooseFormat: () => format,
      }),
    };
  };

  await assert.rejects(
    loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
      clientFactory: createClientFactory(new Error('synthetic content length internals')),
      mediaFetch: async () => {
        mediaFetchCalls += 1;
        throw new Error('media fetch must not be reached');
      },
    }),
    (error) => error.code === 'youtube_local_stream_create_failed'
  );
  assert.equal(mediaFetchCalls, 0);

  await assert.rejects(
    loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
      clientFactory: createClientFactory(0),
    }),
    (error) => error.code === 'youtube_local_media_invalid'
  );

  const missingTitle = await loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
    clientFactory: createClientFactory(3),
    mediaFetch: async () => createRangeResponse(),
  });
  assert.equal(missingTitle.track.title, 'YouTube 音訊');
  await missingTitle.webStream.cancel();
});

test('anonymous source uses only registered matching duration evidence when IOS duration is invalid', async () => {
  for (const [metadataDuration, durationMs, expectedSeconds] of [
    [undefined, 273_000, 273],
    [null, 273_001, 274],
    [Number.NaN, 7_200_000, 7_200],
    ['301ms', 273_000, 273],
  ]) {
    const result = await loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
      clientFactory: createMetadataClient({ duration: metadataDuration }),
      durationEvidence: createDurationEvidence({ durationMs }),
    });

    assert.equal(result.track.duration, expectedSeconds);
    await result.webStream.cancel();
  }

  for (const durationEvidence of [
    { ...createDurationEvidence() },
    createDurationEvidence({ videoId: 'aaaaaaaaaaa', identifier: 'aaaaaaaaaaa', uri: 'https://youtu.be/aaaaaaaaaaa' }),
    null,
  ]) {
    let chooseFormatCalls = 0;
    let mediaFetchCalls = 0;
    await assert.rejects(
      loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
        clientFactory: createMetadataClient(
          { duration: undefined },
          { onChooseFormat: () => { chooseFormatCalls += 1; } }
        ),
        durationEvidence,
        mediaFetch: async () => {
          mediaFetchCalls += 1;
          throw new Error('media body must not be reached');
        },
      }),
      (error) => error.code === 'youtube_local_duration_invalid'
    );
    assert.equal(chooseFormatCalls, 0);
    assert.equal(mediaFetchCalls, 0);
  }
});

test('trusted duration evidence remains fail closed for source, identity, type, and live mismatches', async () => {
  for (const overrides of [
    { sourceName: 'soundcloud' },
    { identifier: 'aaaaaaaaaaa' },
    { uri: 'https://youtu.be/aaaaaaaaaaa' },
    { isStream: true },
    { requestId: '' },
    { encodedTrack: '' },
    { durationMs: '273000' },
    { durationMs: 0 },
    { durationMs: -1 },
    { durationMs: 1.5 },
    { durationMs: Number.NaN },
    { durationMs: Number.POSITIVE_INFINITY },
  ]) {
    assert.equal(createDurationEvidence(overrides), null);
  }

  for (const liveFlags of [{ is_live: true }, { is_live_content: true }]) {
    let chooseFormatCalls = 0;
    await assert.rejects(
      loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
        clientFactory: createMetadataClient(
          { duration: undefined, ...liveFlags },
          { onChooseFormat: () => { chooseFormatCalls += 1; } }
        ),
        durationEvidence: createDurationEvidence(),
      }),
      (error) => error.code === 'youtube_local_live_rejected'
    );
    assert.equal(chooseFormatCalls, 0);
  }
});

test('metadata duration is authoritative and neither source can bypass the 7200 second limit', async () => {
  const metadataWins = await loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
    clientFactory: createMetadataClient({ duration: 301 }),
    durationEvidence: createDurationEvidence({ durationMs: 7_200_001 }),
  });
  assert.equal(metadataWins.track.duration, 301);
  await metadataWins.webStream.cancel();

  for (const testCase of [
    {
      metadataDuration: 7_201,
      durationEvidence: createDurationEvidence({ durationMs: 273_000 }),
    },
    {
      metadataDuration: undefined,
      durationEvidence: createDurationEvidence({ durationMs: 7_200_001 }),
    },
  ]) {
    let chooseFormatCalls = 0;
    let mediaFetchCalls = 0;
    await assert.rejects(
      loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
        clientFactory: createMetadataClient(
          { duration: testCase.metadataDuration },
          { onChooseFormat: () => { chooseFormatCalls += 1; } }
        ),
        durationEvidence: testCase.durationEvidence,
        mediaFetch: async () => {
          mediaFetchCalls += 1;
          throw new Error('media body must not be reached');
        },
      }),
      (error) => error.code === 'youtube_local_duration_overlong'
    );
    assert.equal(chooseFormatCalls, 0);
    assert.equal(mediaFetchCalls, 0);
  }
});

test('anonymous source maps generic info errors to a safe stage code', async () => {

  await assert.rejects(
    loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
      clientFactory: async () => ({
        getBasicInfo: async () => {
          throw new Error('private upstream URL and internals');
        },
      }),
    }),
    (error) =>
      error.code === 'youtube_local_info_failed' &&
      !error.message.includes('private upstream URL')
  );
});

test('anonymous source times out a stalled session without waiting indefinitely', async () => {
  await assert.rejects(
    loadAnonymousYouTubeAudio('dQw4w9WgXcQ', {
      clientFactory: () => new Promise(() => {}),
      requestTimeoutMs: 20,
    }),
    (error) => error.code === 'youtube_local_session_timeout'
  );
});

test('local fallback triggers only for explicit YouTube source rejection', () => {
  const input = 'https://youtu.be/dQw4w9WgXcQ';
  for (const code of ['youtube_source_failed', 'youtube_stream_failed']) {
    assert.equal(shouldUseLocalYouTubeFallback({ code }, input), true);
  }
  for (const code of [
    'youtube_stream_unconfirmed',
    'missing_speak',
    'voice_connect_failed',
    'lavalink_unavailable',
    'lavalink_player_failed',
    'lavalink_load_request_failed',
  ]) {
    assert.equal(shouldUseLocalYouTubeFallback({ code }, input), false);
  }
  assert.equal(shouldUseLocalYouTubeFallback({ code: 'youtube_source_failed' }, 'not a video'), false);
});

test('local fallback readiness fails closed on stream error and removes listeners', async () => {
  const { resource, runtime, state } = createReadinessHarness();
  const outcome = waitForSustainedLocalPlayback(state, resource, runtime, {
    timeoutMs: 100,
    enterPlaying: async () => {},
  });

  runtime.sourceStream.emit('error', new Error('synthetic stream failure'));
  await assert.rejects(outcome, (error) => error.code === 'youtube_local_stream_failed');
  assert.equal(state.player.listenerCount('error'), 0);
  assert.equal(runtime.sourceStream.listenerCount('error'), 0);
  assert.equal(runtime.outputStream.listenerCount('error'), 0);
  assert.equal(runtime.subprocess.listenerCount('error'), 0);
  assert.equal(runtime.subprocess.listenerCount('close'), 0);
});

test('local fallback readiness preserves an allowlisted source error code', async () => {
  const { resource, runtime, state } = createReadinessHarness();
  const outcome = waitForSustainedLocalPlayback(state, resource, runtime, {
    timeoutMs: 100,
    enterPlaying: async () => {},
  });

  runtime.sourceStream.emit('error', new YouTubeLocalSourceError('youtube_local_range_invalid'));
  await assert.rejects(outcome, (error) => error.code === 'youtube_local_range_invalid');
});

test('local fallback warning logs only a safe guild id and allowlisted code', () => {
  const warnings = [];
  const originalWarn = logger.warn;
  logger.warn = (message) => warnings.push(message);

  try {
    for (const code of [
      'youtube_local_metadata_id_mismatch',
      'youtube_local_live_rejected',
      'youtube_local_duration_invalid',
      'youtube_local_duration_overlong',
      'youtube_local_session_failed',
      'youtube_local_info_failed',
      'youtube_local_format_selection_failed',
      'youtube_local_format_decipher_failed',
      'youtube_local_stream_create_failed',
    ]) {
      const knownError = new YouTubeLocalSourceError(code);
      knownError.message = 'synthetic secret https://private.example/media';
      logYouTubeLocalFailure('guild-1', knownError);
    }
    logYouTubeLocalFailure('guild/2', {
      code: 'youtube_local_not_allowlisted',
      message: 'synthetic body and secret',
    });
  } finally {
    logger.warn = originalWarn;
  }

  assert.deepEqual(warnings, [
    '[Music] Local YouTube fallback failed closed: guildId=guild-1 code=youtube_local_metadata_id_mismatch',
    '[Music] Local YouTube fallback failed closed: guildId=guild-1 code=youtube_local_live_rejected',
    '[Music] Local YouTube fallback failed closed: guildId=guild-1 code=youtube_local_duration_invalid',
    '[Music] Local YouTube fallback failed closed: guildId=guild-1 code=youtube_local_duration_overlong',
    '[Music] Local YouTube fallback failed closed: guildId=guild-1 code=youtube_local_session_failed',
    '[Music] Local YouTube fallback failed closed: guildId=guild-1 code=youtube_local_info_failed',
    '[Music] Local YouTube fallback failed closed: guildId=guild-1 code=youtube_local_format_selection_failed',
    '[Music] Local YouTube fallback failed closed: guildId=guild-1 code=youtube_local_format_decipher_failed',
    '[Music] Local YouTube fallback failed closed: guildId=guild-1 code=youtube_local_stream_create_failed',
    '[Music] Local YouTube fallback failed closed: guildId=guild2 code=youtube_local_playback_failed',
  ]);
  assert.doesNotMatch(warnings.join('\n'), /https?:|secret|body|message|stack/i);
});

test('local fallback readiness rejects Playing with no audio data', async () => {
  const { resource, runtime, state } = createReadinessHarness();
  await assert.rejects(
    waitForSustainedLocalPlayback(state, resource, runtime, {
      timeoutMs: 25,
      enterPlaying: async () => {},
    }),
    (error) => error.code === 'youtube_local_no_audio'
  );
  assert.equal(state.player.listenerCount('error'), 0);
  assert.equal(runtime.sourceStream.listenerCount('error'), 0);
});

test('local fallback readiness requires Playing, stream activity, and playback duration', async () => {
  const { resource, runtime, state } = createReadinessHarness();
  runtime.activity.inputBytes = 8_192;
  runtime.activity.outputBytes = 8_192;
  resource.playbackDuration = 1_200;

  const result = await waitForSustainedLocalPlayback(state, resource, runtime, {
    timeoutMs: 250,
    enterPlaying: async () => {},
  });

  assert.deepEqual(result, {
    inputBytes: 8_192,
    outputBytes: 8_192,
    playbackDuration: 1_200,
  });
  assert.equal(state.player.listenerCount('error'), 0);
  assert.equal(runtime.subprocess.listenerCount('close'), 0);
});

test('local fallback runtime cleanup destroys streams and kills ffmpeg', () => {
  const source = new PassThrough();
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };

  const runtime = createYoutubeFallbackRuntime(createWebStream(), {
    readableFromWeb: () => source,
    spawnImpl: () => child,
  });
  let guardCleanupCalls = 0;
  runtime.guardCleanup = () => {
    guardCleanupCalls += 1;
  };
  runtime.cleanup();
  runtime.cleanup();

  assert.equal(runtime.cleaned, true);
  assert.equal(guardCleanupCalls, 1);
  assert.equal(child.killed, true);
  assert.equal(source.destroyed, true);
  assert.equal(runtime.outputStream.destroyed, true);
});

test('local fallback runtime classifies synchronous bridge, spawn, and pipe setup failures', () => {
  assert.throws(
    () => createYoutubeFallbackRuntime(createWebStream(), {
      readableFromWeb: () => { throw new Error('synthetic bridge internals'); },
    }),
    (error) => error.code === 'youtube_local_stream_failed'
  );

  const spawnSource = new PassThrough();
  assert.throws(
    () => createYoutubeFallbackRuntime(createWebStream(), {
      readableFromWeb: () => spawnSource,
      spawnImpl: () => { throw new Error('synthetic spawn internals'); },
    }),
    (error) => error.code === 'youtube_local_ffmpeg_failed'
  );
  assert.equal(spawnSource.destroyed, true);

  const pipeSource = new PassThrough();
  pipeSource.pipe = () => { throw new Error('synthetic pipe internals'); };
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  assert.throws(
    () => createYoutubeFallbackRuntime(createWebStream(), {
      readableFromWeb: () => pipeSource,
      spawnImpl: () => child,
    }),
    (error) => error.code === 'youtube_local_ffmpeg_stream_failed'
  );
  assert.equal(pipeSource.destroyed, true);
  assert.equal(child.killed, true);
});

test('runtime stage conversion preserves known local errors and classifies player failures', () => {
  assert.throws(
    () => runYouTubeLocalRuntimeStage(
      () => { throw new Error('synthetic player internals'); },
      'youtube_local_player_failed'
    ),
    (error) => error.code === 'youtube_local_player_failed'
  );
  assert.throws(
    () => runYouTubeLocalRuntimeStage(
      () => { throw new YouTubeLocalSourceError('youtube_local_no_audio'); },
      'youtube_local_player_failed'
    ),
    (error) => error.code === 'youtube_local_no_audio'
  );
});

test('Readable.fromWeb feeds in-memory audio through ffmpeg as Discord Ogg Opus', async () => {
  const wav = createPcmWav();
  const runtime = createYoutubeFallbackRuntime(createWebStream([wav]));
  const output = [];

  for await (const chunk of runtime.outputStream) output.push(chunk);
  const encoded = Buffer.concat(output);

  assert.ok(runtime.activity.inputBytes >= wav.length);
  assert.ok(runtime.activity.outputBytes > 4_096);
  assert.equal(encoded.subarray(0, 4).toString('ascii'), 'OggS');
  runtime.cleanup();
});
