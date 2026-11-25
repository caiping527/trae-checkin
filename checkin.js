#!/usr/bin/env node
// Trae 云端多账号签到（GitHub Actions 用）
//
// 账号来源：仓库 Secret `TRAE_ACCOUNTS`，内容是 [{uid, nickname, access_token, ...}, ...]
// 由本地 上传.py 生成，同 uid 只更新不重复。
//
// 错峰：账号之间随机 5~15 秒，避免同一时刻一起打上游。
// 幂等：今天签过直接返回 done，不会重复领。

const fs = require('fs')

let protocol
try {
  protocol = require('./protocol.js')
} catch (error) {
  console.error('[致命] 同目录缺少 protocol.js：' + error.message)
  process.exit(2)
}

function readAccounts() {
  const raw = process.env.TRAE_ACCOUNTS || ''
  if (!raw.trim()) {
    console.error('[账号] 环境变量 TRAE_ACCOUNTS 是空的。到仓库 Settings → Secrets → Actions 里检查。')
    process.exit(3)
  }
  let list
  try {
    list = JSON.parse(raw)
  } catch (error) {
    console.error('[账号] TRAE_ACCOUNTS 不是合法 JSON：' + error.message)
    process.exit(4)
  }
  if (!Array.isArray(list) || list.length === 0) {
    console.error('[账号] TRAE_ACCOUNTS 里一个账号都没有。')
    process.exit(5)
  }
  return list
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function checkin(credential) {
  const headers = protocol.checkinHeaders(credential)
  const UG = protocol.UG_HOST || 'https://api.trae.cn'
  const post = async (p, body) => {
    const response = await fetch(UG + p, { method: 'POST', headers, body: JSON.stringify(body) })
    const text = await response.text().catch(() => '')
    let json = {}
    try { json = JSON.parse(text) } catch { /* 非 JSON 靠 text 报错 */ }
    return { status: response.status, json, text }
  }

  const statusResp = await post(protocol.CHECKIN_STATUS_PATH, { req_source: 1 })
  if (statusResp.status >= 400) {
    return { outcome: 'error', message: `状态查询 HTTP ${statusResp.status}`, detail: statusResp.text.slice(0, 160) }
  }
  const before = protocol.parseCheckinStatus(statusResp.json)
  if (protocol.CHECKIN_AUTH_CODES.has(before.code)) {
    return { outcome: 'auth', message: '鉴权失败，需要重新登录' }
  }
  if (before.checkedIn) {
    return { outcome: 'done', credits: before.credits }
  }
  if (!before.enabled) {
    return { outcome: 'ineligible', message: '未开通签到活动' }
  }
  const claimResp = await post(protocol.CHECKIN_CLAIM_PATH, { req_source: 1 })
  const claim = protocol.parseClaimResponse(claimResp.json)
  if (claim.code === 9074) return { outcome: 'busy', message: '签到人数过多' }
  if (!claim.ok) return { outcome: 'error', message: claim.message || '领取失败', detail: claimResp.text.slice(0, 160) }
  const afterResp = await post(protocol.CHECKIN_STATUS_PATH, { req_source: 1 })
  const after = protocol.parseCheckinStatus(afterResp.json)
  return { outcome: 'claimed', credits: after.credits, extraCredits: after.extraCredits, streakDays: after.streakDays }
}

async function main() {
  const accounts = readAccounts()
  console.log(`[账号] 共 ${accounts.length} 个 Trae 账号，逐号签到（错峰 5~15 秒）`)

  const results = []
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i]
    const label = `${account.nickname || '未命名'}(${account.uid})`
    process.stdout.write(`[${i + 1}/${accounts.length}] ${label} … `)
    let result
    try {
      result = await checkin(account)
    } catch (error) {
      result = { outcome: 'error', message: error.message }
    }
    console.log(result.outcome + (result.credits !== undefined ? `（积分 ${result.credits}）` : ''))
    if (result.outcome === 'auth') {
      console.log('   修法：本地 AI路由 → 渠道账号 → Trae 删号重扫，然后重新跑 上传.py。')
    }
    results.push({ account, result })
    if (i < accounts.length - 1) await sleep(5000 + Math.floor(Math.random() * 10000))
  }

  const claimed = results.filter(r => r.result.outcome === 'claimed').length
  const done = results.filter(r => r.result.outcome === 'done').length
  const failed = results.filter(r => ['auth', 'error', 'busy'].includes(r.result.outcome))
  console.log(`\n完成：新领 ${claimed} · 已签 ${done} · 失败 ${failed.length} · 未开通 ${results.filter(r => r.result.outcome === 'ineligible').length}`)
  for (const item of failed) {
    console.log(`  ${item.account.nickname || item.account.uid}：${item.result.message || ''}`)
  }
  if (failed.length) process.exit(1)
}

main().catch(error => {
  console.error('[致命] ' + error.message)
  process.exit(7)
})
