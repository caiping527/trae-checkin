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

// 企业微信推送：WECOM 是四段凭据 corpid,corpsecret,touser,agentid（仓库 Secret）
async function pushWecom(text) {
  const raw = (process.env.WECOM || '').trim()
  if (!raw) return false
  const parts = raw.split(',').map(item => item.trim())
  if (parts.length < 4 || !parts[0] || !parts[1]) return false
  const [corpid, secret, touser, agentid] = parts
  try {
    const tokenResp = await fetch('https://qyapi.weixin.qq.com/cgi-bin/gettoken?' + new URLSearchParams({
      corpid, corpsecret: secret,
    }))
    const token = await tokenResp.json()
    if (!token.access_token) return false
    const sendResp = await fetch('https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token='
      + encodeURIComponent(token.access_token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: touser || '@all',
        msgtype: 'text',
        agentid: Number(agentid),
        text: { content: text },
        safe: 0,
      }),
    })
    const result = await sendResp.json()
    return result.errcode === 0
  } catch {
    return false
  }
}

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

  const lines = [
    `【Trae签到】${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    `新领 ${claimed} · 已签 ${done} · 失败 ${failed.length} · 未开通 ${results.filter(r => r.result.outcome === 'ineligible').length}`,
  ]
  for (const item of results) {
    const name = item.account.nickname || item.account.uid
    let line = `${name}：${item.result.outcome}`
    if (item.result.credits !== undefined) line += `（积分 ${item.result.credits}）`
    if (['auth', 'error', 'busy'].includes(item.result.outcome) && item.result.message) {
      line += ` — ${item.result.message}`
    }
    lines.push(line)
  }
  const pushed = await pushWecom(lines.join('\n'))
  console.log(`[推送] 企业微信：${pushed ? '已发送' : '未发送（没配 WECOM 或发送失败）'}`)
  if (failed.length) process.exit(1)
}

main().catch(error => {
  console.error('[致命] ' + error.message)
  process.exit(7)
})
