import { ipcMain } from 'electron';
import type { MobileGatewayServer } from './mobileServer';

export function registerMobileIpc(getServer: () => MobileGatewayServer | undefined): void {
  ipcMain.handle('mobile:status', async () => getServer()?.getStatus() ?? null);
  ipcMain.handle('mobile:toggle', async (_event, enabled?: boolean) => {
    const mobileServer = getServer();
    if (!mobileServer) return null;
    const status = await mobileServer.getStatus();
    const shouldRun = enabled ?? !status.isRunning;
    if (shouldRun && !status.isRunning) {
      await mobileServer.start();
    } else if (!shouldRun && status.isRunning) {
      await mobileServer.stop();
    }
    return mobileServer.getStatus();
  });
  ipcMain.handle('mobile:regeneratePin', async () => {
    const mobileServer = getServer();
    if (!mobileServer) return null;
    mobileServer.regeneratePin();
    return mobileServer.getStatus();
  });
  ipcMain.handle('mobile:revoke', async (_event, token: string) => {
    const mobileServer = getServer();
    if (!mobileServer) return null;
    mobileServer.revokeClient(token);
    return mobileServer.getStatus();
  });
  ipcMain.handle('mobile:revokeAll', async () => {
    const mobileServer = getServer();
    if (!mobileServer) return null;
    mobileServer.revokeAll();
    return mobileServer.getStatus();
  });
}
