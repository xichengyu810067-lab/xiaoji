const youtubeVideoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const youtubeSourceRequestTimeoutMs = 15_000;
const youtubeSourceMaxDurationSeconds = 2 * 60 * 60;
const youtubeMediaChunkBytes = 64 * 1024;
const youtubeSourceMaxBytes = 512 * 1024 * 1024;
const youtubeLocalErrorCodes = new Set([
  'youtube_local_api_unavailable',
  'youtube_local_duration_invalid',
  'youtube_local_duration_overlong',
  'youtube_local_fetch_unavailable',
  'youtube_local_ffmpeg_failed',
  'youtube_local_ffmpeg_missing',
  'youtube_local_ffmpeg_stream_failed',
  'youtube_local_format_timeout',
  'youtube_local_import_timeout',
  'youtube_local_info_timeout',
  'youtube_local_invalid_video',
  'youtube_local_lavalink_cleanup_failed',
  'youtube_local_length_invalid',
  'youtube_local_live_rejected',
  'youtube_local_media_host_rejected',
  'youtube_local_media_invalid',
  'youtube_local_metadata_id_mismatch',
  'youtube_local_no_audio',
  'youtube_local_playback_failed',
  'youtube_local_player_failed',
  'youtube_local_player_not_playing',
  'youtube_local_range_invalid',
  'youtube_local_session_timeout',
  'youtube_local_source_failed',
  'youtube_local_stream_empty',
  'youtube_local_stream_failed',
  'youtube_local_stream_invalid',
  'youtube_local_stream_timeout',
]);

function normalizeDurationSeconds(value) {
  let durationSeconds;

  if (typeof value === 'number') {
    durationSeconds = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value)) {
    durationSeconds = Number(value);
  } else {
    return null;
  }

  return Number.isSafeInteger(durationSeconds) && durationSeconds > 0
    ? durationSeconds
    : null;
}

function getSafeYouTubeLocalErrorCode(error, fallbackCode = 'youtube_local_playback_failed') {
  const safeFallback = youtubeLocalErrorCodes.has(fallbackCode)
    ? fallbackCode
    : 'youtube_local_playback_failed';
  const candidate = String(error?.code || '');
  return youtubeLocalErrorCodes.has(candidate) ? candidate : safeFallback;
}

function isYouTubeLocalError(error) {
  return youtubeLocalErrorCodes.has(String(error?.code || ''));
}

class YouTubeLocalSourceError extends Error {
  constructor(code = 'youtube_local_source_failed') {
    super('本機 YouTube 音訊來源目前無法使用。');
    this.name = 'YouTubeLocalSourceError';
    this.code = getSafeYouTubeLocalErrorCode({ code }, 'youtube_local_source_failed');
  }
}

function extractStrictYouTubeVideoId(input) {
  const value = String(input || '').trim();
  if (youtubeVideoIdPattern.test(value)) return value;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

    const host = parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
    let videoId = null;

    if (host === 'youtu.be') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length === 1) videoId = parts[0];
    } else if (host === 'youtube.com' && parsed.pathname === '/watch') {
      videoId = parsed.searchParams.get('v');
    } else if (host === 'youtube.com' && parsed.pathname.startsWith('/shorts/')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length === 2 && parts[0] === 'shorts') videoId = parts[1];
    }

    return youtubeVideoIdPattern.test(videoId || '') ? videoId : null;
  } catch {
    return null;
  }
}

function createAnonymousFetch({ timeoutMs = youtubeSourceRequestTimeoutMs, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new YouTubeLocalSourceError('youtube_local_fetch_unavailable');
  }

  return async (input, init = {}) => {
    const controller = new AbortController();
    const upstreamSignal = init.signal;
    const onUpstreamAbort = () => controller.abort(upstreamSignal.reason);
    const timer = setTimeout(() => controller.abort(new Error('youtube source request timeout')), timeoutMs);

    if (upstreamSignal?.aborted) onUpstreamAbort();
    else upstreamSignal?.addEventListener?.('abort', onUpstreamAbort, { once: true });

    try {
      return await fetchImpl(input, {
        ...init,
        credentials: 'omit',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      upstreamSignal?.removeEventListener?.('abort', onUpstreamAbort);
    }
  };
}

function withTimeout(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new YouTubeLocalSourceError(code)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sanitizeVideoTitle(title) {
  return String(title || 'YouTube 音訊')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/@/g, '＠')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'YouTube 音訊';
}

function isAllowedYouTubeMediaUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && (host === 'googlevideo.com' || host.endsWith('.googlevideo.com'));
  } catch {
    return false;
  }
}

function getValidatedRangeLength(response, rangeStart, rangeEnd, totalBytes) {
  if (response?.status !== 206 || !response.body?.getReader) {
    throw new YouTubeLocalSourceError('youtube_local_stream_invalid');
  }
  if (response.url && !isAllowedYouTubeMediaUrl(response.url)) {
    throw new YouTubeLocalSourceError('youtube_local_media_host_rejected');
  }

  const contentRange = String(response.headers?.get?.('content-range') || '').trim();
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(contentRange);
  if (!match) throw new YouTubeLocalSourceError('youtube_local_range_invalid');

  const responseStart = Number(match[1]);
  const responseEnd = Number(match[2]);
  const responseTotal = Number(match[3]);
  if (
    !Number.isSafeInteger(responseStart) ||
    !Number.isSafeInteger(responseEnd) ||
    !Number.isSafeInteger(responseTotal) ||
    responseStart !== rangeStart ||
    responseEnd !== rangeEnd ||
    responseTotal !== totalBytes
  ) {
    throw new YouTubeLocalSourceError('youtube_local_range_invalid');
  }

  const expectedBytes = rangeEnd - rangeStart + 1;
  const contentLengthValue = response.headers?.get?.('content-length');
  if (contentLengthValue !== null && contentLengthValue !== undefined) {
    const normalizedContentLength = String(contentLengthValue).trim();
    if (!/^\d+$/.test(normalizedContentLength) || Number(normalizedContentLength) !== expectedBytes) {
      throw new YouTubeLocalSourceError('youtube_local_length_invalid');
    }
  }

  return expectedBytes;
}

function createRangedMediaStream(
  mediaUrl,
  contentLength,
  {
    mediaFetch = createAnonymousFetch(),
    requestTimeoutMs = youtubeSourceRequestTimeoutMs,
    chunkBytes = youtubeMediaChunkBytes,
  } = {}
) {
  const totalBytes = Number(contentLength);
  if (
    !isAllowedYouTubeMediaUrl(mediaUrl) ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 0 ||
    totalBytes > youtubeSourceMaxBytes
  ) {
    throw new YouTubeLocalSourceError('youtube_local_media_invalid');
  }

  let offset = 0;
  let cancelled = false;
  let activeAbortController = null;
  let activeReader = null;

  return new ReadableStream({
    async pull(controller) {
      if (cancelled) return;
      if (offset >= totalBytes) {
        controller.close();
        return;
      }

      const rangeEnd = Math.min(offset + chunkBytes - 1, totalBytes - 1);
      activeAbortController = new AbortController();

      try {
        const response = await withTimeout(
          mediaFetch(mediaUrl, {
            headers: { Range: `bytes=${offset}-${rangeEnd}` },
            redirect: 'error',
            signal: activeAbortController.signal,
          }),
          requestTimeoutMs,
          'youtube_local_stream_timeout'
        );
        const expectedBytes = getValidatedRangeLength(response, offset, rangeEnd, totalBytes);

        activeReader = response.body.getReader();
        let receivedBytes = 0;
        const chunks = [];
        while (true) {
          const { done, value } = await activeReader.read();
          if (done) break;
          if (cancelled) return;
          if (value?.byteLength) {
            if (
              receivedBytes + value.byteLength > expectedBytes ||
              offset + receivedBytes + value.byteLength > youtubeSourceMaxBytes
            ) {
              throw new YouTubeLocalSourceError('youtube_local_length_invalid');
            }
            receivedBytes += value.byteLength;
            chunks.push(value);
          }
        }
        if (cancelled) return;
        if (receivedBytes !== expectedBytes) {
          throw new YouTubeLocalSourceError(
            receivedBytes <= 0 ? 'youtube_local_stream_empty' : 'youtube_local_length_invalid'
          );
        }

        for (const chunk of chunks) controller.enqueue(chunk);
        offset = rangeEnd + 1;
        if (offset >= totalBytes) controller.close();
      } catch (error) {
        if (cancelled) return;
        activeAbortController?.abort(error);
        try {
          await activeReader?.cancel?.(error);
        } catch {
          // The response may already be closed; the stream still fails closed below.
        }
        controller.error(
          error instanceof YouTubeLocalSourceError
            ? error
            : new YouTubeLocalSourceError('youtube_local_stream_failed')
        );
      } finally {
        activeReader?.releaseLock?.();
        activeReader = null;
        activeAbortController = null;
      }
    },
    async cancel(reason) {
      cancelled = true;
      activeAbortController?.abort(reason);
      try {
        await activeReader?.cancel?.(reason);
      } catch {
        // Cancellation is best effort; the network timeout remains the final bound.
      }
    },
  });
}

async function createAnonymousInnertube({ importYoutubei = () => import('youtubei.js'), fetchImpl } = {}) {
  const module = await withTimeout(importYoutubei(), youtubeSourceRequestTimeoutMs, 'youtube_local_import_timeout');
  const Innertube = module?.Innertube;
  if (!Innertube?.create) throw new YouTubeLocalSourceError('youtube_local_api_unavailable');

  return withTimeout(
    Innertube.create({
      enable_session_cache: false,
      fetch: createAnonymousFetch({ fetchImpl }),
    }),
    youtubeSourceRequestTimeoutMs,
    'youtube_local_session_timeout'
  );
}

async function loadAnonymousYouTubeAudio(
  input,
  {
    clientFactory = createAnonymousInnertube,
    mediaFetch = createAnonymousFetch(),
    requestTimeoutMs = youtubeSourceRequestTimeoutMs,
    maxDurationSeconds = youtubeSourceMaxDurationSeconds,
  } = {}
) {
  const videoId = extractStrictYouTubeVideoId(input);
  if (!videoId) throw new YouTubeLocalSourceError('youtube_local_invalid_video');

  try {
    const client = await withTimeout(clientFactory(), requestTimeoutMs, 'youtube_local_session_timeout');
    const info = await withTimeout(
      client.getBasicInfo(videoId, { client: 'IOS' }),
      requestTimeoutMs,
      'youtube_local_info_timeout'
    );
    const returnedVideoId = info?.basic_info?.id;
    const returnedVideoIdAbsent =
      returnedVideoId === undefined ||
      returnedVideoId === null ||
      (typeof returnedVideoId === 'string' && returnedVideoId.trim() === '');
    if (
      !returnedVideoIdAbsent &&
      (typeof returnedVideoId !== 'string' || returnedVideoId !== videoId)
    ) {
      throw new YouTubeLocalSourceError('youtube_local_metadata_id_mismatch');
    }
    if (info?.basic_info?.is_live || info?.basic_info?.is_live_content) {
      throw new YouTubeLocalSourceError('youtube_local_live_rejected');
    }

    const durationSeconds = normalizeDurationSeconds(info?.basic_info?.duration);
    if (durationSeconds === null) {
      throw new YouTubeLocalSourceError('youtube_local_duration_invalid');
    }
    const durationLimitSeconds =
      Number.isSafeInteger(maxDurationSeconds) &&
      maxDurationSeconds > 0 &&
      maxDurationSeconds <= youtubeSourceMaxDurationSeconds
        ? maxDurationSeconds
        : youtubeSourceMaxDurationSeconds;
    if (durationSeconds > durationLimitSeconds) {
      throw new YouTubeLocalSourceError('youtube_local_duration_overlong');
    }

    const format = info.chooseFormat({ type: 'audio', quality: 'best', format: 'any' });
    const mediaUrl = await withTimeout(
      format.decipher(client.session?.player),
      requestTimeoutMs,
      'youtube_local_format_timeout'
    );
    if (!isAllowedYouTubeMediaUrl(mediaUrl)) {
      throw new YouTubeLocalSourceError('youtube_local_media_host_rejected');
    }

    const webStream = createRangedMediaStream(mediaUrl, format.content_length, {
      mediaFetch,
      requestTimeoutMs,
    });

    return {
      webStream,
      track: {
        title: sanitizeVideoTitle(info.basic_info.title),
        duration: durationSeconds,
        source: 'youtube-local',
      },
    };
  } catch (error) {
    if (error instanceof YouTubeLocalSourceError) throw error;
    throw new YouTubeLocalSourceError('youtube_local_source_failed');
  }
}

module.exports = {
  YouTubeLocalSourceError,
  createAnonymousFetch,
  createAnonymousInnertube,
  createRangedMediaStream,
  extractStrictYouTubeVideoId,
  getSafeYouTubeLocalErrorCode,
  getValidatedRangeLength,
  isAllowedYouTubeMediaUrl,
  isYouTubeLocalError,
  loadAnonymousYouTubeAudio,
  normalizeDurationSeconds,
  sanitizeVideoTitle,
  youtubeSourceMaxDurationSeconds,
  youtubeMediaChunkBytes,
  youtubeSourceMaxBytes,
  youtubeSourceRequestTimeoutMs,
};
