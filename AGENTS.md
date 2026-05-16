\# Discord 全能機器人《小吉》開發規劃書



\## 一、專案目標



請建立一個 Discord 聊天與伺服器管理機器人，名稱為：



> 小吉



小吉的定位不是單純聊天機器人，而是「伺服器小管家」與「AI 聊天助手」的結合體。



目前第一階段需要完成：



1\. 小吉可以正常上線。

2\. 使用者在頻道中 `@小吉` 時，小吉會回覆聊天。

3\. 小吉支援基本 Slash Commands。

4\. 小吉具備基本伺服器管理功能。

5\. 管理功能只能由伺服器管理員或指定擁有者使用。

6\. Token、伺服器 ID、擁有者 ID 等機密資料必須放在 `.env`，不可寫死在程式碼中。

7\. 專案結構要清楚，方便之後繼續擴充。



\---



\## 二、技術要求



請使用以下技術：



\- Node.js

\- discord.js v14

\- dotenv

\- JavaScript ESM module



`package.json` 需設定：



```json

{

\&#x20; "type": "module"

}

```



\---



\## 三、必要環境變數



請建立 `.env.example`，內容如下：



```env

DISCORD\\\_TOKEN=your\\\_discord\\\_bot\\\_token\\\_here

CLIENT\\\_ID=your\\\_discord\\\_application\\\_client\\\_id\\\_here

GUILD\\\_ID=your\\\_test\\\_server\\\_id\\\_here

OWNER\\\_ID=your\\\_discord\\\_user\\\_id\\\_here

OPENAI\\\_API\\\_KEY=optional\\\_openai\\\_api\\\_key\\\_here

```



實際 `.env` 不要提交到 Git。



\---



\## 四、Discord Developer Portal 設定前提



此機器人預期已在 Discord Developer Portal 完成以下設定：



\### Privileged Gateway Intents



請假設以下 Intents 已開啟：



\- Server Members Intent

\- Message Content Intent



以下 Intent 暫時不需要：



\- Presence Intent



\### OAuth2 Scopes



邀請機器人時需要：



\- bot

\- applications.commands



\### Bot Permissions



測試階段可以使用：



\- Administrator



但程式內仍然必須做權限檢查，避免一般成員濫用管理指令。



\---



\## 五、專案檔案結構



請建立以下結構：



```txt

xiaoji-discord-bot/

├─ src/

│  ├─ index.js

│  ├─ deploy-commands.js

│  ├─ handlers/

│  │  ├─ commandHandler.js

│  │  └─ eventHandler.js

│  ├─ events/

│  │  ├─ ready.js

│  │  ├─ messageCreate.js

│  │  ├─ interactionCreate.js

│  │  └─ guildMemberAdd.js

│  ├─ commands/

│  │  ├─ utility/

│  │  │  ├─ ping.js

│  │  │  ├─ help.js

│  │  │  └─ server.js

│  │  ├─ moderation/

│  │  │  ├─ clear.js

│  │  │  ├─ timeout.js

│  │  │  ├─ kick.js

│  │  │  ├─ ban.js

│  │  │  └─ unban.js

│  │  ├─ role/

│  │  │  ├─ role-add.js

│  │  │  └─ role-remove.js

│  │  └─ config/

│  │     ├─ set-welcome.js

│  │     └─ set-log.js

│  ├─ services/

│  │  ├─ aiService.js

│  │  ├─ permissionService.js

│  │  ├─ configService.js

│  │  └─ logService.js

│  ├─ data/

│  │  └─ guildConfig.json

│  └─ utils/

│     ├─ safeReply.js

│     └─ formatDuration.js

├─ .env.example

├─ .gitignore

├─ package.json

└─ README.md

```



\---



\## 六、package.json 需求



請建立 `package.json`，至少包含：



```json

{

\&#x20; "name": "xiaoji-discord-bot",

\&#x20; "version": "1.0.0",

\&#x20; "description": "小吉 Discord 全能聊天與管理機器人",

\&#x20; "type": "module",

\&#x20; "main": "src/index.js",

\&#x20; "scripts": {

\&#x20;   "start": "node src/index.js",

\&#x20;   "deploy": "node src/deploy-commands.js"

\&#x20; },

\&#x20; "dependencies": {

\&#x20;   "discord.js": "^14.0.0",

\&#x20;   "dotenv": "^16.0.0"

\&#x20; }

}

```



\---



\## 七、Discord Client Intents



`src/index.js` 需要建立 Discord client，並使用以下 intents：



```js

GatewayIntentBits.Guilds

GatewayIntentBits.GuildMessages

GatewayIntentBits.MessageContent

GatewayIntentBits.GuildMembers

GatewayIntentBits.GuildModeration

```



若某些 intent 在 discord.js v14 中名稱不同，請依照 discord.js v14 實際可用名稱修正。



\---



\## 八、核心功能需求



\### 1. 上線提示



當小吉成功登入後，在 console 顯示：



```txt

小吉上線啦！目前登入身份：小吉#xxxx

```



\---



\### 2. @小吉 聊天功能



當使用者在伺服器文字頻道中提到小吉，例如：



```txt

@小吉 你好

```



小吉需要回覆。



基本行為：



1\. 忽略其他機器人的訊息。

2\. 只有被 @ 時才回覆。

3\. 將訊息中的 `<@botId>` 或 `<@!botId>` 移除，只保留使用者真正輸入的文字。

4\. 若使用者只輸入 `@小吉`，回覆：



```txt

我在我在～小吉來了！

```



5\. 若使用者輸入內容，回覆時應根據內容生成聊天回應。



第一階段 AI 規則：



\- 如果 `.env` 有 `OPENAI\\\_API\\\_KEY`，請在 `aiService.js` 保留可擴充的 AI 呼叫接口。

\- 如果沒有 `OPENAI\\\_API\\\_KEY`，不可讓程式崩潰，改用內建簡單回覆。

\- 內建簡單回覆可以先根據關鍵字處理：

&#x20; - 你好 / 嗨

&#x20; - 晚安

&#x20; - 你是誰

&#x20; - 幫我寫公告

&#x20; - 其他一般訊息



範例：



```txt

使用者：@小吉 你好

小吉：你好呀～我是小吉！今天也來陪大家聊天！

```



\---



\## 九、Slash Commands 需求



請使用 command handler，不要把所有 Slash Commands 寫在同一個檔案。



每個 command file 需要 export：



```js

export const data = ...

export async function execute(interaction) { ... }

```



或使用一致的 default export 格式也可以，但整個專案必須統一。



\---



\## 十、Slash Commands 清單



\### 1. `/ping`



用途：測試小吉是否正常。



回覆：



```txt

Pong！小吉目前在線～

```



\---



\### 2. `/help`



用途：顯示小吉可用指令。



需要列出：



\- 一般指令

\- 管理指令

\- 身分組指令

\- 設定指令



回覆建議使用 Discord Embed。



\---



\### 3. `/server`



用途：顯示目前伺服器資訊。



至少顯示：



\- 伺服器名稱

\- 成員數

\- 建立時間

\- 伺服器擁有者

\- 小吉目前所在伺服器 ID



\---



\## 十一、管理功能需求



所有管理指令都必須做權限檢查。



可以使用以下任一條件通過：



1\. 使用者是 `.env` 裡的 `OWNER\\\_ID`

2\. 使用者具有 Administrator 權限

3\. 使用者具有該指令需要的 Discord 權限，例如 ManageMessages、KickMembers、BanMembers、ModerateMembers



若權限不足，回覆：



```txt

你沒有權限使用這個指令喔。

```



回覆建議使用 ephemeral。



\---



\### 1. `/clear amount`



用途：刪除指定數量訊息。



參數：



\- `amount`：整數，1 到 100



限制：



\- 只能刪除 1 到 100 則訊息。

\- 不要刪除超過 Discord 限制的舊訊息。

\- 成功後回覆：



```txt

已清除 {amount} 則訊息。

```



\---



\### 2. `/timeout user duration reason`



用途：禁言指定使用者。



參數：



\- `user`：目標成員

\- `duration`：時間字串，例如 `10m`、`1h`、`1d`

\- `reason`：原因，可選



需求：



\- 需要解析時間字串。

\- 支援：

&#x20; - `s` 秒

&#x20; - `m` 分鐘

&#x20; - `h` 小時

&#x20; - `d` 天



範例：



```txt

/timeout @某人 10m 洗版

```



成功回覆：



```txt

已將 @某人 timeout 10m。

原因：洗版

```



\---



\### 3. `/kick user reason`



用途：踢出成員。



參數：



\- `user`

\- `reason` 可選



需求：



\- 檢查機器人是否有權限踢出該使用者。

\- 不可踢出伺服器擁有者。

\- 不可踢出身分組高於或等於小吉的成員。



\---



\### 4. `/ban user reason`



用途：封鎖成員。



參數：



\- `user`

\- `reason` 可選



需求：



\- 檢查權限。

\- 不可封鎖伺服器擁有者。

\- 不可封鎖身分組高於或等於小吉的成員。



\---



\### 5. `/unban user-id reason`



用途：解除封鎖。



參數：



\- `user-id`

\- `reason` 可選



成功回覆：



```txt

已解除封鎖使用者 ID：{userId}

```



\---



\## 十二、身分組功能需求



\### 1. `/role-add user role`



用途：替成員新增身分組。



參數：



\- `user`

\- `role`



需求：



\- 小吉不能管理高於或等於自己身分組的 role。

\- 執行者也必須有管理身分組權限。

\- 成功後回覆：



```txt

已替 @使用者 加上 @身分組。

```



\---



\### 2. `/role-remove user role`



用途：移除成員身分組。



參數：



\- `user`

\- `role`



需求與 `/role-add` 相同。



\---



\## 十三、伺服器設定功能



設定資料先使用 JSON 檔儲存，不需要資料庫。



檔案：



```txt

src/data/guildConfig.json

```



資料格式範例：



```json

{

\&#x20; "guildId": {

\&#x20;   "welcomeChannelId": "channel\\\_id\\\_here",

\&#x20;   "logChannelId": "channel\\\_id\\\_here"

\&#x20; }

}

```



\---



\### 1. `/set-welcome channel`



用途：設定新人歡迎頻道。



參數：



\- `channel`



成功回覆：



```txt

新人歡迎頻道已設定為 #頻道名稱。

```



\---



\### 2. `/set-log channel`



用途：設定管理紀錄頻道。



參數：



\- `channel`



成功回覆：



```txt

管理紀錄頻道已設定為 #頻道名稱。

```



\---



\## 十四、新成員歡迎功能



當新成員加入伺服器時，如果該伺服器已設定 welcome channel，小吉要在該頻道發送歡迎訊息：



```txt

歡迎 @新成員 加入伺服器！小吉在這裡向你打招呼～

```



若尚未設定 welcome channel，則不做任何事，不要報錯。



\---



\## 十五、管理紀錄功能



當以下指令成功執行時，如果有設定 log channel，小吉要在 log channel 發送紀錄：



\- `/clear`

\- `/timeout`

\- `/kick`

\- `/ban`

\- `/unban`

\- `/role-add`

\- `/role-remove`



紀錄內容至少包含：



\- 執行者

\- 目標使用者

\- 動作

\- 原因

\- 時間



\---



\## 十六、安全需求



請特別注意以下安全規則：



1\. 不可把 Discord Token 寫死在程式碼中。

2\. 不可把 `.env` 加入 Git。

3\. 一般成員不可使用管理指令。

4\. 管理指令必須檢查使用者權限。

5\. 管理指令必須檢查小吉自己的權限。

6\. 小吉不可嘗試管理伺服器擁有者。

7\. 小吉不可管理身分組高於或等於自己的成員。

8\. 所有指令錯誤都要用友善訊息回覆，不要讓機器人直接崩潰。

9\. 所有 async function 需要有 try/catch 或集中錯誤處理。

10\. 對使用者輸入的數量、時間、ID 都要做驗證。



\---



\## 十七、錯誤處理需求



若指令執行失敗，小吉應回覆：



```txt

小吉剛剛執行失敗了，原因：{錯誤摘要}

```



不要把完整 stack trace 顯示給 Discord 使用者。



完整錯誤可以輸出到 console。



\---



\## 十八、README.md 需求



請建立 README.md，內容包含：



1\. 專案介紹

2\. 安裝方式

3\. `.env` 設定方式

4\. 如何部署 Slash Commands

5\. 如何啟動機器人

6\. Discord Developer Portal 需要開啟哪些 Intents

7\. 目前支援的指令列表



\---



\## 十九、安裝與啟動流程



README 需要提供以下流程：



```bash

npm install

cp .env.example .env

npm run deploy

npm start

```



Windows PowerShell 可以使用：



```powershell

copy .env.example .env

npm run deploy

npm start

```



\---



\## 二十、完成標準



當我執行以下指令時：



```bash

npm install

npm run deploy

npm start

```



需要達成：



1\. Terminal 顯示小吉已上線。

2\. Discord 伺服器中可以使用 `/ping`。

3\. Discord 伺服器中可以使用 `/help`。

4\. 在頻道輸入 `@小吉 你好`，小吉會回覆。

5\. `/clear 5` 可以清除訊息。

6\. `/timeout` 可以禁言成員。

7\. `/set-welcome` 可以設定歡迎頻道。

8\. 新成員加入時，小吉會在歡迎頻道發送訊息。

9\. 權限不足的使用者無法使用管理指令。

10\. 程式不會因為一般錯誤直接崩潰。



\---



\## 二十一、開發優先順序



請依照以下順序完成：



1\. 建立專案結構

2\. 建立 Discord client 並讓小吉上線

3\. 建立 command handler

4\. 建立 deploy-commands.js

5\. 完成 `/ping`

6\. 完成 `/help`

7\. 完成 `@小吉` 聊天功能

8\. 完成權限檢查服務

9\. 完成 `/clear`

10\. 完成 `/timeout`

11\. 完成 `/kick`

12\. 完成 `/ban`

13\. 完成 `/unban`

14\. 完成身分組功能

15\. 完成歡迎頻道設定

16\. 完成新人歡迎事件

17\. 完成管理紀錄功能

18\. 補上 README.md



\---



\## 二十二、額外要求



請輸出完整可執行專案，不要只給片段程式碼。



請確保：



\- 所有 import 路徑正確

\- 所有 command 都能被 deploy script 正確讀取

\- 所有 Slash Command name 都使用小寫英文或連字號

\- 中文只放在 description 與回覆文字中

\- 程式碼清楚、有註解

\- 不要使用 TypeScript

\- 不要使用資料庫

\- 不要使用 Docker

\- 第一版以能在本機穩定運作為主

