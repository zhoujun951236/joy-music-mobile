/**
 * Expo Config Plugin: 把 ios/JoyRemoteCommands.{swift,m} 拷贝到 prebuild 出来的
 * iOS 工程里，并加入到 Xcode project 的 Sources Build Phase。
 *
 * 同时确保 Info.plist 中存在 audio 后台模式。
 */
const fs = require('fs')
const path = require('path')
const {
  withDangerousMod,
  withXcodeProject,
  withInfoPlist,
} = require('@expo/config-plugins')

const HEADER_FILE_NAME = 'JoyRemoteCommands.h'
const OBJC_FILE_NAME = 'JoyRemoteCommands.m'

function copyIfNeeded(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (fs.existsSync(dest)) {
    const a = fs.readFileSync(src, 'utf8')
    const b = fs.readFileSync(dest, 'utf8')
    if (a === b) return
  }
  fs.copyFileSync(src, dest)
}

const withCopySource = (config) => {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot
      const iosRoot = cfg.modRequest.platformProjectRoot
      const srcDir = path.join(projectRoot, 'plugins', 'remote-commands', 'ios')
      const projectName = cfg.modRequest.projectName
      const targetDir = path.join(iosRoot, projectName)

      copyIfNeeded(
        path.join(srcDir, HEADER_FILE_NAME),
        path.join(targetDir, HEADER_FILE_NAME),
      )
      copyIfNeeded(
        path.join(srcDir, OBJC_FILE_NAME),
        path.join(targetDir, OBJC_FILE_NAME),
      )

      return cfg
    },
  ])
}

const withRegisterInXcodeProject = (config) => {
  return withXcodeProject(config, async (cfg) => {
    const project = cfg.modResults
    const projectName = cfg.modRequest.projectName

    const groupKey = project.findPBXGroupKey({ name: projectName })

    const ensureSourceFile = (fileName) => {
      if (!groupKey) return
      const fileRefs = project.hash.project.objects['PBXFileReference'] || {}
      const exists = Object.values(fileRefs).some(
        (ref) => typeof ref === 'object' && ref?.path === fileName,
      )
      if (exists) return
      project.addSourceFile(
        `${projectName}/${fileName}`,
        { target: project.getFirstTarget().uuid },
        groupKey,
      )
    }

    const ensureHeaderFile = (fileName) => {
      if (!groupKey) return
      const fileRefs = project.hash.project.objects['PBXFileReference'] || {}
      const exists = Object.values(fileRefs).some(
        (ref) => typeof ref === 'object' && ref?.path === fileName,
      )
      if (exists) return
      project.addHeaderFile(
        `${projectName}/${fileName}`,
        { target: project.getFirstTarget().uuid },
        groupKey,
      )
    }

    ensureHeaderFile(HEADER_FILE_NAME)
    ensureSourceFile(OBJC_FILE_NAME)

    return cfg
  })
}

const withAudioBackground = (config) => {
  return withInfoPlist(config, (cfg) => {
    const modes = cfg.modResults.UIBackgroundModes || []
    if (!modes.includes('audio')) {
      cfg.modResults.UIBackgroundModes = [...modes, 'audio']
    }
    return cfg
  })
}

module.exports = function withJoyRemoteCommands(config) {
  config = withAudioBackground(config)
  config = withCopySource(config)
  config = withRegisterInXcodeProject(config)
  return config
}
