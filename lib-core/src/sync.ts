export async function registerSyncPlugin(plugin: SyncPlugin) {
  await plugin.load();
}