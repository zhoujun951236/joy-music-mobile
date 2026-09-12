#!/usr/bin/env node
/**
 * 本地签名工具 web 服务
 *   POST /inspect  multipart: ipa            -> JSON {appName, bundleId, version}
 *   POST /sign     multipart: ipa, p12, provision, p12Password, appName, bundleId
 *                  -> SSE: {log} | {error} | {downloadUrl, filename}
 *   GET  /download?token=xxx                 -> 下载签好的 IPA(下载后从磁盘清掉)
 *
 * 没用任何第三方依赖,Node 标准库 + macOS 自带 codesign/PlistBuddy/zip/openssl。
 */

import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync, createReadStream, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const PORT = 5817
const HOST = '127.0.0.1'
const INDEX_HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), 'index.html')
const downloads = new Map()  // token -> {path, filename}

// ------ 收 multipart body ------
function readBody(req, limitBytes = 200 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > limitBytes) { reject(new Error('payload too large')); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function parseMultipart(buf, boundary) {
  const delim = Buffer.from(`--${boundary}`)
  const parts = []
  let i = buf.indexOf(delim)
  if (i < 0) return parts
  i += delim.length + 2
  while (i < buf.length) {
    const headerEnd = buf.indexOf('\r\n\r\n', i)
    if (headerEnd < 0) break
    const headers = buf.subarray(i, headerEnd).toString('utf8')
    const bodyStart = headerEnd + 4
    const nextBoundary = buf.indexOf(delim, bodyStart)
    if (nextBoundary < 0) break
    const body = buf.subarray(bodyStart, nextBoundary - 2)  // strip \r\n
    const disposition = /Content-Disposition:[^\r\n]+/i.exec(headers)?.[0] || ''
    const name = /name="([^"]+)"/.exec(disposition)?.[1]
    const filename = /filename="([^"]*)"/.exec(disposition)?.[1]
    if (name) parts.push({ name, filename: filename || null, body })
    i = nextBoundary + delim.length + 2
    if (buf.subarray(nextBoundary + delim.length, nextBoundary + delim.length + 2).toString() === '--') break
  }
  return parts
}

function getBoundary(contentType) {
  const m = /boundary=(?:"?([^";]+)"?)/i.exec(contentType || '')
  return m?.[1]
}

// ------ 解析 IPA 拿元信息 ------
function readIpaInfo(ipaPath) {
  const tmp = mkdtempSync(join(tmpdir(), 'sign-inspect-'))
  try {
    // 只解 Payload/<App>.app/Info.plist 这一层(用 -x 排除子 bundle 里的同名 plist)
    execFileSync('/usr/bin/unzip', ['-q', '-o', ipaPath, 'Payload/*.app/Info.plist', '-d', tmp], { stdio: 'pipe' })
    // 限制 maxdepth=3,只匹配 Payload/<App>.app/Info.plist,排除 SplashScreen.storyboardc 等内嵌的
    const found = execFileSync('/usr/bin/find', [
      join(tmp, 'Payload'), '-maxdepth', '2', '-mindepth', '2', '-name', 'Info.plist',
    ], { encoding: 'utf8' }).split('\n').filter(Boolean)[0]
    if (!found) throw new Error('IPA 内未找到 Payload/<App>.app/Info.plist')
    const cmd = (key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, found], { encoding: 'utf8' }).trim()
    return {
      appName: (() => { try { return cmd('CFBundleDisplayName') } catch { return cmd('CFBundleName') } })(),
      bundleId: cmd('CFBundleIdentifier'),
      version: cmd('CFBundleShortVersionString'),
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ------ 签名主流程 ------
function signIpa({ ipaPath, p12Path, p12Password, provisionPath, entitlementsPath, appName, bundleId, log }) {
  // 1) 从 p12 解出 cert SHA1
  log('解析 p12 证书...')
  // macOS 自带 LibreSSL,不识别 -legacy(那是 brew OpenSSL 3 的 flag);LibreSSL 默认能读老 p12。
  const p12Pem = execFileSync('/usr/bin/openssl', [
    'pkcs12', '-in', p12Path, '-nokeys', '-passin', `pass:${p12Password}`,
  ], { encoding: 'utf8' })
  const fingerprint = execFileSync('/usr/bin/openssl', ['x509', '-noout', '-fingerprint', '-sha1'], {
    input: p12Pem, encoding: 'utf8',
  }).split('=')[1].replace(/:/g, '').trim()
  log(`证书 SHA1: ${fingerprint}`)

  // 2) keychain 检查/临时导入
  const identities = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  if (!identities.includes(fingerprint)) {
    log('keychain 缺这张证书,临时导入到 login.keychain...')
    execFileSync('/usr/bin/security', [
      'import', p12Path, '-k', `${process.env.HOME}/Library/Keychains/login.keychain-db`,
      '-P', p12Password, '-T', '/usr/bin/codesign',
    ])
  }

  // 3) 解 IPA
  const workDir = mkdtempSync(join(tmpdir(), 'sign-work-'))
  try {
    log('解 IPA...')
    execFileSync('/usr/bin/unzip', ['-q', ipaPath, '-d', workDir], { stdio: 'pipe' })
    const appPath = execFileSync('/usr/bin/find', [join(workDir, 'Payload'), '-maxdepth', '1', '-name', '*.app', '-type', 'd'], { encoding: 'utf8' }).split('\n').filter(Boolean)[0]
    if (!appPath) throw new Error('IPA 内未发现 Payload/*.app')
    const infoPlist = join(appPath, 'Info.plist')

    // 4) 替换 mobileprovision
    copyFileSync(provisionPath, join(appPath, 'embedded.mobileprovision'))

    // 5) 改 App Name / Bundle ID
    const orig = readIpaInfo(ipaPath)
    if (appName && appName !== orig.appName) {
      log(`改 App Name: ${orig.appName} -> ${appName}`)
      try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleDisplayName ${appName}`, infoPlist]) }
      catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :CFBundleDisplayName string ${appName}`, infoPlist]) }
    }
    if (bundleId && bundleId !== orig.bundleId) {
      log(`改 Bundle ID: ${orig.bundleId} -> ${bundleId}`)
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIdentifier ${bundleId}`, infoPlist])
    }

    // 6) 签 frameworks/dylibs
    const fwRoot = join(appPath, 'Frameworks')
    if (existsSync(fwRoot)) {
      const list = execFileSync('/usr/bin/find', [fwRoot, '-maxdepth', '1', '-mindepth', '1'], { encoding: 'utf8' }).split('\n').filter(Boolean)
      for (const item of list) {
        log(`签: ${basename(item)}`)
        execFileSync('/usr/bin/codesign', ['--force', '--sign', fingerprint, item])
      }
    }

    // 7) 签主 app(传 entitlements,把 application-identifier 实例化)
    log(`签主 app(entitlements: ${basename(entitlementsPath)})`)
    execFileSync('/usr/bin/codesign', [
      '--force', '--sign', fingerprint,
      '--entitlements', entitlementsPath,
      appPath,
    ])

    // 8) 打 IPA 到下载缓存
    const downloadDir = mkdtempSync(join(tmpdir(), 'sign-out-'))
    const filename = `${basename(ipaPath, extname(ipaPath)).replace(/-unsigned$/, '')}-signed.ipa`
    const outPath = join(downloadDir, filename)
    execFileSync('/usr/bin/zip', ['-qry', outPath, 'Payload'], { cwd: workDir })
    log(`打包完成: ${filename}`)
    return { outPath, filename, downloadDir }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

// ------ HTTP 服务 ------
createServer(async(req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(readFileSync(INDEX_HTML_PATH))
      return
    }

    if (req.method === 'GET' && req.url.startsWith('/download')) {
      const token = new URL(req.url, `http://${HOST}`).searchParams.get('token')
      const entry = downloads.get(token)
      if (!entry) { res.writeHead(404); res.end('token expired'); return }
      const size = statSync(entry.path).size
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${entry.filename}"`,
        'Content-Length': size,
      })
      const stream = createReadStream(entry.path)
      stream.pipe(res)
      stream.on('close', () => {
        rmSync(entry.dir, { recursive: true, force: true })
        downloads.delete(token)
      })
      return
    }

    if (req.method === 'POST' && req.url === '/inspect') {
      const boundary = getBoundary(req.headers['content-type'])
      if (!boundary) { res.writeHead(400); res.end('no boundary'); return }
      const buf = await readBody(req)
      const parts = parseMultipart(buf, boundary)
      const ipaPart = parts.find(p => p.name === 'ipa')
      if (!ipaPart) { res.writeHead(400); res.end('no ipa'); return }
      const tmp = mkdtempSync(join(tmpdir(), 'sign-up-'))
      const ipaPath = join(tmp, ipaPart.filename || 'in.ipa')
      writeFileSync(ipaPath, ipaPart.body)
      try {
        const info = readIpaInfo(ipaPath)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(info))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e.message || e) }))
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
      return
    }

    if (req.method === 'POST' && req.url === '/sign') {
      const boundary = getBoundary(req.headers['content-type'])
      if (!boundary) { res.writeHead(400); res.end('no boundary'); return }
      const buf = await readBody(req)
      const parts = parseMultipart(buf, boundary)
      const part = (n) => parts.find(p => p.name === n)
      const fieldStr = (n) => part(n)?.body.toString('utf8') ?? ''

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      const log = (m) => send({ log: m })

      const upDir = mkdtempSync(join(tmpdir(), 'sign-up-'))
      try {
        const ipaPart = part('ipa'), p12Part = part('p12'), provPart = part('provision')
        const entPart = part('entitlements')
        if (!ipaPart || !p12Part || !provPart) throw new Error('缺少必要文件')
        const ipaPath = join(upDir, ipaPart.filename || 'in.ipa')
        const p12Path = join(upDir, p12Part.filename || 'cert.p12')
        const provisionPath = join(upDir, provPart.filename || 'p.mobileprovision')
        writeFileSync(ipaPath, ipaPart.body)
        writeFileSync(p12Path, p12Part.body)
        writeFileSync(provisionPath, provPart.body)
        // entitlements 可选,未上传时落回默认模板
        const DEFAULT_ENTITLEMENTS = '/Users/berta/Downloads/ResignTool-macos20230128/joymusic.entitlements'
        let entitlementsPath
        if (entPart) {
          entitlementsPath = join(upDir, entPart.filename || 'app.entitlements')
          writeFileSync(entitlementsPath, entPart.body)
        } else if (existsSync(DEFAULT_ENTITLEMENTS)) {
          entitlementsPath = DEFAULT_ENTITLEMENTS
        } else {
          throw new Error('未上传 entitlements,且找不到默认模板 ' + DEFAULT_ENTITLEMENTS)
        }

        const result = signIpa({
          ipaPath, p12Path, provisionPath, entitlementsPath,
          p12Password: fieldStr('p12Password'),
          appName: fieldStr('appName'),
          bundleId: fieldStr('bundleId'),
          log,
        })

        const token = randomBytes(8).toString('hex')
        downloads.set(token, { path: result.outPath, filename: result.filename, dir: result.downloadDir })
        // 10 分钟没下载就清掉
        setTimeout(() => {
          const e = downloads.get(token)
          if (e) { rmSync(e.dir, { recursive: true, force: true }); downloads.delete(token) }
        }, 10 * 60 * 1000)

        send({ done: true, downloadUrl: `/download?token=${token}`, filename: result.filename })
      } catch (e) {
        send({ error: String(e.stderr?.toString() || e.message || e) })
      } finally {
        rmSync(upDir, { recursive: true, force: true })
        res.end()
      }
      return
    }

    res.writeHead(404)
    res.end('Not Found')
  } catch (e) {
    if (!res.headersSent) res.writeHead(500)
    res.end(String(e.message || e))
  }
}).listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`
  console.log(`==> 签名工具运行在 ${url}`)
  console.log('==> 按 Ctrl+C 退出')
  spawn('/usr/bin/open', [url], { stdio: 'ignore', detached: true }).unref()
})
