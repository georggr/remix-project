import {ElectronBasePlugin, ElectronBasePluginClient} from '@remixproject/plugin-electron'
import fs from 'fs/promises'
import {Profile} from '@remixproject/plugin-utils'
import chokidar from 'chokidar'
import {dialog, shell} from 'electron'
import {createWindow, isPackaged} from '../main'
import {writeConfig} from '../utils/config'
import path from 'path'
import {customAction} from '@remixproject/plugin-api'

const profile: Profile = {
  displayName: 'fs',
  name: 'fs',
  description: 'fs',
}

const convertPathToPosix = (pathName: string): string => {
  return pathName.split(path.sep).join(path.posix.sep)
}

const getBaseName = (pathName: string): string => {
  return path.basename(pathName)
}

export class FSPlugin extends ElectronBasePlugin {
  clients: FSPluginClient[] = []
  constructor() {
    super(profile, clientProfile, FSPluginClient)
    this.methods = [...super.methods, 'closeWatch', 'removeCloseListener']
  }

  async onActivation(): Promise<void> {
    const config = await this.call('electronconfig' as any, 'readConfig')
    const openedFolders = (config && config.openedFolders) || []
    this.call('electronconfig', 'writeConfig', {openedFolders: openedFolders})
    const foldersToDelete: string[] = []
    if (openedFolders && openedFolders.length) {
      for (const folder of openedFolders) {
        try {
          const stat = await fs.stat(folder)
          if (stat.isDirectory()) {
            createWindow(folder)
          }
        } catch (e) {
          console.log('error opening folder', folder, e)
          foldersToDelete.push(folder)
        }
      }
      if (foldersToDelete.length) {
        const newFolders = openedFolders.filter((f: string) => !foldersToDelete.includes(f))
        this.call('electronconfig', 'writeConfig', {recentFolders: newFolders})
      }
    } else {
      createWindow()
    }
  }

  async removeCloseListener(): Promise<void> {
    for (const client of this.clients) {
      client.window.removeAllListeners()
    }
  }

  async closeWatch(): Promise<void> {
    for (const client of this.clients) {
      await client.closeWatch()
    }
  }

  openFolder(webContentsId: any): void {
    const client = this.clients.find((c) => c.webContentsId === webContentsId)
    if (client) {
      client.openFolder()
    }
  }
}

const clientProfile: Profile = {
  name: 'fs',
  displayName: 'fs',
  description: 'fs',
  methods: ['readdir', 'readFile', 'writeFile', 'mkdir', 'rmdir', 'unlink', 'rename', 'stat', 'lstat', 'exists', 'currentPath', 'watch', 'closeWatch', 'setWorkingDir', 'openFolder', 'openFolderInSameWindow', 'getRecentFolders', 'removeRecentFolder', 'openWindow', 'selectFolder', 'revealInExplorer', 'openInVSCode', 'openInVSCode'],
}

class FSPluginClient extends ElectronBasePluginClient {
  watchers: Record<string, chokidar.FSWatcher> = {}
  workingDir: string = ''
  trackDownStreamUpdate: Record<string, string> = {}
  expandedPaths: string[] = ['.']

  constructor(webContentsId: number, profile: Profile) {
    super(webContentsId, profile)
    this.onload(() => {
      if (!isPackaged) {
        this.window.webContents.openDevTools()
      }
      this.window.on('close', async () => {
        await this.removeFromOpenedFolders(this.workingDir)
        await this.closeWatch()
      })
    })
  }

  // best for non recursive
  async readdir(path: string): Promise<string[]> {
    if (this.workingDir === '') throw new Error('workingDir is not set')
    // call node fs.readdir
    if (!path) return []
    const startTime = Date.now()
    const files = await fs.readdir(this.fixPath(path), {
      withFileTypes: true,
    })

    const result: any[] = []
    for (const file of files) {
      const isDirectory = file.isDirectory()
      result.push({
        file: file.name,
        isDirectory,
      })
    }
    return result
  }

  async readFile(path: string, options: any): Promise<string | undefined> {
    // hacky fix for TS error
    if (!path) return undefined
    try {
      return (fs as any).readFile(this.fixPath(path), options)
    } catch (e) {
      return undefined
    }
  }

  async writeFile(path: string, content: string, options: any): Promise<void> {
    this.trackDownStreamUpdate[path] = content
    return (fs as any).writeFile(this.fixPath(path), content, options)
  }

  async mkdir(path: string): Promise<void> {
    return fs.mkdir(this.fixPath(path))
  }

  async rmdir(path: string): Promise<void> {
    await fs.rm(this.fixPath(path), {
      recursive: true,
    })
    this.emit('change', 'unlinkDir', path)
  }

  async unlink(path: string): Promise<void> {
    return fs.unlink(this.fixPath(path))
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    return fs.rename(this.fixPath(oldPath), this.fixPath(newPath))
  }

  async stat(path: string): Promise<any> {
    try {
      const stat = await fs.stat(this.fixPath(path))
      const isDirectory = stat.isDirectory()
      return {
        ...stat,
        isDirectoryValue: isDirectory,
      }
    } catch (e) {
      return undefined
    }
  }

  async lstat(path: string): Promise<any> {
    try {
      const stat = await fs.lstat(this.fixPath(path))
      const isDirectory = stat.isDirectory()
      return {
        ...stat,
        isDirectoryValue: isDirectory,
      }
    } catch (e) {
      return undefined
    }
  }

  async exists(path: string): Promise<boolean> {
    return fs
      .access(this.fixPath(path))
      .then(() => true)
      .catch(() => false)
  }

  async currentPath(): Promise<string> {
    return process.cwd()
  }

  async watch(): Promise<void> {
    try {
      this.on('filePanel' as any, 'expandPathChanged', async (paths: string[]) => {
        this.expandedPaths = ['.', ...paths] // add root
        for (let path of paths) {
          if (!this.watchers[path]) {
            path = this.fixPath(path)
            this.watchers[path] = await this.watcherInit(path)
            console.log('added watcher', path)
          }
        }
        paths = paths.map((path) => this.fixPath(path))
        for (const watcher in this.watchers) {
          if (watcher === this.workingDir) continue
          if (!paths.includes(watcher)) {
            this.watchers[watcher].close()
            delete this.watchers[watcher]
            console.log('removed watcher', watcher)
          }
        }
      })
      this.watchers[this.workingDir] = await this.watcherInit(this.workingDir) // root
      console.log('added root watcher', this.workingDir)
    } catch (e) {
      console.log('error watching', e)
    }
  }

  private async watcherInit(path: string) {
    const watcher = chokidar
      .watch(path, {
        ignorePermissionErrors: true,
        ignoreInitial: true,
        ignored: [
          '**/.git/index.lock', // this file is created and unlinked all the time when git is running on Windows
        ],
        depth: 0,
      })
      .on('all', async (eventName, path, stats) => {
        this.watcherExec(eventName, path)
      })
      .on('error', (error) => {
        watcher.close()
        if (error.message.includes('ENOSPC')) {
          this.emit('error', 'ENOSPC')
        }
        console.log(`Watcher error: ${error}`)
      })
    return watcher
  }

  private async watcherExec(eventName: string, eventPath: string) {
    let pathWithoutPrefix = eventPath.replace(this.workingDir, '')
    pathWithoutPrefix = convertPathToPosix(pathWithoutPrefix)
    if (pathWithoutPrefix.startsWith('/')) pathWithoutPrefix = pathWithoutPrefix.slice(1)

    if (eventName === 'change') {
      // remove workingDir from path
      const newContent = await fs.readFile(eventPath, 'utf-8')

      const currentContent = this.trackDownStreamUpdate[pathWithoutPrefix]

      if (currentContent !== newContent) {
        try {
          const dirname = path.dirname(pathWithoutPrefix)
          if (this.expandedPaths.includes(dirname) || this.expandedPaths.includes(pathWithoutPrefix)) {
            console.log('emitting', eventName, pathWithoutPrefix, this.expandedPaths)
            this.emit('change', eventName, pathWithoutPrefix)
          }
          this.emit('change', eventName, pathWithoutPrefix)
        } catch (e) {
          console.log('error emitting change', e)
        }
      }
    } else {
      try {
        const dirname = path.dirname(pathWithoutPrefix)
        console.log('check emitting', eventName, pathWithoutPrefix, this.expandedPaths, dirname)
        if (this.expandedPaths.includes(dirname) || this.expandedPaths.includes(pathWithoutPrefix)) {
          console.log('emitting', eventName, pathWithoutPrefix, this.expandedPaths)
          this.emit('change', eventName, pathWithoutPrefix)
        }
      } catch (e) {
        console.log('error emitting change', e)
      }
    }
  }

  async closeWatch(): Promise<void> {
    for (const watcher in this.watchers) {
      this.watchers[watcher].close()
    }
  }

  async updateRecentFolders(path: string): Promise<void> {
    const config = await this.call('electronconfig' as any, 'readConfig')
    config.recentFolders = config.recentFolders || []
    config.recentFolders = config.recentFolders.filter((p: string) => p !== path)
    config.recentFolders.push(path)
    writeConfig(config)
  }

  async updateOpenedFolders(path: string): Promise<void> {
    const config = await this.call('electronconfig' as any, 'readConfig')
    config.openedFolders = config.openedFolders || []
    config.openedFolders = config.openedFolders.filter((p: string) => p !== path)
    config.openedFolders.push(path)
    writeConfig(config)
  }

  async removeFromOpenedFolders(path: string): Promise<void> {
    const config = await this.call('electronconfig' as any, 'readConfig')
    config.openedFolders = config.openedFolders || []
    config.openedFolders = config.openedFolders.filter((p: string) => p !== path)
    writeConfig(config)
  }

  async getRecentFolders(): Promise<string[]> {
    const config = await this.call('electronconfig' as any, 'readConfig')
    return config.recentFolders || []
  }

  async removeRecentFolder(path: string): Promise<void> {
    const config = await this.call('electronconfig' as any, 'readConfig')
    config.recentFolders = config.recentFolders || []
    config.recentFolders = config.recentFolders.filter((p: string) => p !== path)
    writeConfig(config)
  }

  async selectFolder(path?: string, title?: string): Promise<string> {
    let dirs: string[] | undefined
    if (!path) {
      dirs = dialog.showOpenDialogSync(this.window, {
        properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
      })
    }
    path = dirs && dirs.length && dirs[0] ? dirs[0] : path
    if (!path) return ''
    return path
  }

  async openFolder(path?: string): Promise<void> {
    let dirs: string[] | undefined
    if (!path) {
      dirs = dialog.showOpenDialogSync(this.window, {
        properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
      })
    }
    path = dirs && dirs.length && dirs[0] ? dirs[0] : path
    if (!path) return

    await this.updateRecentFolders(path)
    await this.updateOpenedFolders(path)
    this.openWindow(path)
  }

  async openFolderInSameWindow(path?: string): Promise<void> {
    let dirs: string[] | undefined
    if (!path) {
      dirs = dialog.showOpenDialogSync(this.window, {
        properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
      })
    }
    path = dirs && dirs.length && dirs[0] ? dirs[0] : path
    if (!path) return
    this.workingDir = path
    await this.updateRecentFolders(path)
    await this.updateOpenedFolders(path)
    this.window.setTitle(this.workingDir)
    this.watch()
    this.emit('workingDirChanged', path)
  }

  async setWorkingDir(path: string): Promise<void> {
    this.workingDir = path
    await this.updateRecentFolders(path)
    await this.updateOpenedFolders(path)
    this.window.setTitle(getBaseName(this.workingDir))
    this.watch()
    this.emit('workingDirChanged', path)
    await this.call('fileManager', 'closeAllFiles')
  }

  async revealInExplorer(action: customAction): Promise<void> {
    shell.showItemInFolder(this.fixPath(action.path[0]))
  }

  async openInVSCode(action: customAction): Promise<void> {
    shell.openExternal(`vscode://file/${this.fixPath(action.path[0])}`)
  }

  fixPath(path: string): string {
    if (this.workingDir === '') throw new Error('workingDir is not set')
    if (path) {
      if (path.startsWith('/')) {
        path = path.slice(1)
      }
    }
    path = this.workingDir + (!this.workingDir.endsWith('/') ? '/' : '') + path
    return path
  }

  openWindow(path: string): void {
    createWindow(path)
  }
}
