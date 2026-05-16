# 小吉安全檢查清單

- `.env` 已列在 `.gitignore`。
- 不在 README、docs 或 log 中輸出 `DISCORD_TOKEN`、`OPENWEATHER_API_KEY`、`GROQ_API_KEY`、`OPENAI_API_KEY` 的值。
- 管理指令在執行時檢查使用者權限；沒有權限者只能看到拒絕訊息，不會執行動作。
- 身分組新增、移除與 autorole 都會檢查小吉身分組階層。
- `/announce` 預設禁止實際 mention。
- `/export-config` 只匯出 guild config。
- 使用 `npm run audit` 檢查相依套件漏洞。
