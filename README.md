# Trae 每日签到

账号由本地 `上传.py` 维护，同 uid 只更新不重复。

- 签到：`.github/workflows/trae-checkin.yml`，每天北京时间约 03:50
- 播报：尾号 + 当前积分 + 几天后开始过期 + 三天内过期合计 + 建议提前一天用掉
- Secret：`TRAE_ACCOUNTS`（账号 JSON）
- 本文件只记录 uid / 昵称 / 手机号，不含任何令牌
