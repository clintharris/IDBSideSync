import * as db from './db';
import { debug, libName, log } from './utils';

const plugins: SyncPlugin[] = [];

export async function sync() {
  debug && log.debug('Starting sync...');
  for (const plugin of plugins) {
    for (const remoteEntry in plugin.getEntries()) {
      log.debug('todo: apply remote entry to local store:', remoteEntry);
    }

    for (const localEntry in db.getEntries()) {
      log.debug('todo: updload local entry to remote store:', localEntry);
      // Note: we do not want the database to actually load the next entry until we have finished saving the current one
      // await store.saveEntry(localEntry);
    }
  }
}

export async function registerSyncPlugin(plugin: SyncPlugin) {
  if (!isSyncPlugin(plugin)) {
    throw new Error(`${libName}: argument does not properly implement the SyncPlugin interface`);
  }

  await plugin.load();

  plugin.addSignInChangeListener((userProfile: UserProfile | null) => {
    onPluginSignInChange(plugin, userProfile);
  });

  plugins.push(plugin);

  const syncProfileForPlugin = getSyncProfileForPlugin(plugin.getPluginId());
  if (syncProfileForPlugin) {
    debug && log.debug(`Passing saved settings to '${plugin.getPluginId()}' plugin:`, syncProfileForPlugin.settings);
    plugin.setSettings(syncProfileForPlugin.settings);

    if (!plugin.isSignedIn()) {
      debug && log.debug(`Asking '${plugin.getPluginId()}' plugin to sign-in to remote service...`);
      plugin.signIn();
    }
  }
}

function onPluginSignInChange(plugin: SyncPlugin, userProfile: UserProfile | null) {
  const pluginId = plugin.getPluginId();
  debug && log.debug(`Handling sign-in change from '${pluginId}' plugin; user profile:`, userProfile);

  if (userProfile) {
    addSyncProfile({
      pluginId: pluginId,
      userProfile: userProfile,
      settings: plugin.getSettings(),
    });
  } else {
    removeSyncProfile(plugin.getPluginId());
  }
}

export function getSyncProfileForPlugin(pluginId: string): SyncProfile | undefined {
  return getSyncProfiles().find((existing) => existing.pluginId === pluginId);
}

export function getSyncProfiles(): SyncProfile[] {
  const settings = db.getSettings();
  return Array.isArray(settings?.syncProfiles) ? settings.syncProfiles : [];
}

export async function addSyncProfile(newProfile: SyncProfile) {
  if (getSyncProfileForPlugin(newProfile.pluginId)) {
    debug &&
      log.debug(
        `Ignoring request to add sync profile for plugin '${newProfile.pluginId}' and user ` +
          `'${newProfile.userProfile.email}'; profile already exists.`
      );
    return;
  }
  debug && log.debug(`Adding sync profile for '${newProfile.pluginId}'`);
  const newSettings = { ...db.getSettings() };
  newSettings.syncProfiles = [...newSettings.syncProfiles, newProfile];
  await db.saveSettings(newSettings);
}

export async function removeSyncProfile(pluginId: string) {
  const existingProfileIndex = getSyncProfiles().findIndex((existing) => existing.pluginId === pluginId);
  if (existingProfileIndex === -1) {
    debug && log.debug(`Ignoring request to remove sync profile for plugin '${pluginId}'; profile doesn't exist.`);
    return;
  }

  debug && log.debug(`Removing sync profile for '${pluginId}'`);
  const newSettings = { ...db.getSettings() };
  newSettings.syncProfiles = [
    ...newSettings.syncProfiles.slice(0, existingProfileIndex),
    ...newSettings.syncProfiles.slice(existingProfileIndex + 1),
  ];
  await db.saveSettings(newSettings);
}

/**
 * Utility / type guard function for verifying that something implements the SyncPlugin interface.
 */
export function isSyncPlugin(thing: unknown): thing is SyncPlugin {
  if (!thing) {
    return false;
  }

  const candidate = thing as SyncPlugin;

  if (!(candidate.getPluginId instanceof Function)) {
    return false;
  } else if (typeof candidate.getPluginId() !== 'string') {
    return false;
  }

  if (!(candidate.load instanceof Function)) {
    return false;
  }

  if (!(candidate.addSignInChangeListener instanceof Function)) {
    return false;
  }

  if (!(candidate.getSettings instanceof Function)) {
    return false;
  }

  if (!(candidate.getEntries instanceof Function)) {
    return false;
  }

  if (!(candidate.addEntry instanceof Function)) {
    return false;
  }

  return true;
}
