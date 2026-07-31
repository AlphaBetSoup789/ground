import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import {
  PACKAGED_SMOKE_PRELOAD_CHANNEL,
  parsePackagedSmokePreloadToken
} from '../shared/packaged-smoke'
import type {
  DesktopApi,
  DesktopRunEventEnvelope,
  TerminalEvent
} from '../shared/types'
import { createCopyAssistantOutputInvoker } from './user-activation'

const copyAssistantOutput = createCopyAssistantOutputInvoker({
  currentUserActivation: () => navigator.userActivation,
  invoke: (channel, input) => ipcRenderer.invoke(channel, input)
})

const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot),
  copyAssistantOutput,
  listStateSnapshots: () => ipcRenderer.invoke(IPC.listStateSnapshots),
  exportStateSnapshot: (snapshotId) =>
    ipcRenderer.invoke(IPC.exportStateSnapshot, snapshotId),
  restoreStateSnapshot: (snapshotId) =>
    ipcRenderer.invoke(IPC.restoreStateSnapshot, snapshotId),
  createTask: (workspaceGrantId) =>
    ipcRenderer.invoke(IPC.createTask, workspaceGrantId),
  forkTask: (taskId) => ipcRenderer.invoke(IPC.forkTask, taskId),
  setTaskArchived: (taskId, archived) =>
    ipcRenderer.invoke(IPC.setTaskArchived, taskId, archived),
  importTaskBundle: () => ipcRenderer.invoke(IPC.importTaskBundle),
  exportTask: (taskId, format) =>
    ipcRenderer.invoke(IPC.exportTask, taskId, format),
  deleteTask: (taskId) => ipcRenderer.invoke(IPC.deleteTask, taskId),
  selectTask: (taskId) => ipcRenderer.invoke(IPC.selectTask, taskId),
  updateTask: (taskId, patch) => ipcRenderer.invoke(IPC.updateTask, taskId, patch),
  chooseWorkspace: () => ipcRenderer.invoke(IPC.chooseWorkspace),
  revealWorkspace: (workspaceGrantId) =>
    ipcRenderer.invoke(IPC.revealWorkspace, workspaceGrantId),
  saveProvider: (draft) => ipcRenderer.invoke(IPC.saveProvider, draft),
  deleteProvider: (providerId) => ipcRenderer.invoke(IPC.deleteProvider, providerId),
  testProvider: (draft) => ipcRenderer.invoke(IPC.testProvider, draft),
  detectClis: () => ipcRenderer.invoke(IPC.detectClis),
  chooseCliExecutable: () => ipcRenderer.invoke(IPC.chooseCliExecutable),
  startRun: (input) => ipcRenderer.invoke(IPC.startRun, input),
  stopRun: (runId) => ipcRenderer.invoke(IPC.stopRun, runId),
  resolveApproval: (runId, approvalId, approved) =>
    ipcRenderer.invoke(IPC.resolveApproval, runId, approvalId, approved),
  onRunEvent: (listener) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      envelope: DesktopRunEventEnvelope
    ): void => {
      listener(envelope)
    }
    ipcRenderer.on(IPC.runEvent, wrapped)
    return () => ipcRenderer.removeListener(IPC.runEvent, wrapped)
  },
  listTerminals: (taskId) => ipcRenderer.invoke(IPC.listTerminals, taskId),
  createTerminal: (taskId, dimensions) =>
    ipcRenderer.invoke(IPC.createTerminal, taskId, dimensions),
  attachTerminal: (taskId, sessionId) =>
    ipcRenderer.invoke(IPC.attachTerminal, taskId, sessionId),
  detachTerminal: (sessionId, attachmentId) =>
    ipcRenderer.invoke(IPC.detachTerminal, sessionId, attachmentId),
  terminalInput: (sessionId, attachmentId, data) =>
    ipcRenderer.invoke(IPC.terminalInput, sessionId, attachmentId, data),
  terminalResize: (sessionId, attachmentId, dimensions) =>
    ipcRenderer.invoke(
      IPC.terminalResize,
      sessionId,
      attachmentId,
      dimensions
    ),
  terminalClose: (sessionId, attachmentId) =>
    ipcRenderer.invoke(IPC.terminalClose, sessionId, attachmentId),
  onTerminalEvent: (listener) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      terminalEvent: TerminalEvent
    ): void => {
      listener(terminalEvent)
    }
    ipcRenderer.on(IPC.terminalEvent, wrapped)
    return () => ipcRenderer.removeListener(IPC.terminalEvent, wrapped)
  },
  getGitOverview: (taskId) => ipcRenderer.invoke(IPC.getGitOverview, taskId),
  chooseGitExecutable: () => ipcRenderer.invoke(IPC.chooseGitExecutable),
  createGitWorktree: (taskId, input) =>
    ipcRenderer.invoke(IPC.createGitWorktree, taskId, input),
  stageGitPaths: (taskId, paths) =>
    ipcRenderer.invoke(IPC.stageGitPaths, taskId, paths),
  unstageGitPaths: (taskId, paths) =>
    ipcRenderer.invoke(IPC.unstageGitPaths, taskId, paths),
  revertGitPaths: (taskId, paths) =>
    ipcRenderer.invoke(IPC.revertGitPaths, taskId, paths),
  undoGitRecovery: (taskId, recoveryId) =>
    ipcRenderer.invoke(IPC.undoGitRecovery, taskId, recoveryId),
  commitGitChanges: (taskId, input) =>
    ipcRenderer.invoke(IPC.commitGitChanges, taskId, input),
  removeGitWorktree: (taskId, relativePath) =>
    ipcRenderer.invoke(IPC.removeGitWorktree, taskId, relativePath),
  saveMcpServer: (draft) => ipcRenderer.invoke(IPC.saveMcpServer, draft),
  deleteMcpServer: (serverId) => ipcRenderer.invoke(IPC.deleteMcpServer, serverId),
  getMcpServerStatuses: () => ipcRenderer.invoke(IPC.getMcpServerStatuses),
  connectMcpServer: (serverId) => ipcRenderer.invoke(IPC.connectMcpServer, serverId),
  trustMcpTools: (serverId, expectedFingerprints) =>
    ipcRenderer.invoke(IPC.trustMcpTools, serverId, expectedFingerprints)
}

contextBridge.exposeInMainWorld('ground', api)

const packagedSmokeToken = parsePackagedSmokePreloadToken(process.argv)
if (packagedSmokeToken) {
  ipcRenderer.send(PACKAGED_SMOKE_PRELOAD_CHANNEL, packagedSmokeToken)
}
