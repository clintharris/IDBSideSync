import * as db from './db';
import { HLTime } from './HLTime';
import { debug, libName, log } from './utils';

const plugins: SyncPlugin[] = [];

export async function sync(options: { forceFullSync?: boolean } = {}) {
  const { nodeId: localClientId } = db.getSettings();

  // Attempt to do a sync using each registered plugin
  for (const plugin of plugins) {
    const pluginId = plugin.getPluginId();
    try {
      debug && log.debug(`Attempting to sync with remote storage using '${pluginId}' plugin.`);

      await plugin.saveRemoteClientRecord(localClientId);

      // Which of this client's own oplog entries needs to be uploaded to the server?
      let mostRecentUploadedEntryTime = options.forceFullSync ? null : await plugin.getMostRecentUploadedEntryTime();

      if (mostRecentUploadedEntryTime) {
        log.debug(`Uploading OWN local entries created after ${mostRecentUploadedEntryTime}.`);
      } else {
        log.debug(`Uploading ALL local entries.`);
      }

      // Upload own oplog entries that are missing from the server.
      let ownEntryUploadCounter = 0;
      for await (const localEntry of db.getEntriesByClient(localClientId, { afterTime: mostRecentUploadedEntryTime })) {
        //TODO: Add support for uploading more than one entry at a time (batching)
        let hlTime = HLTime.parse(localEntry.hlcTime);
        let result = await plugin.saveRemoteEntry({
          time: new Date(hlTime.millis()),
          counter: hlTime.counter(),
          clientId: hlTime.node(),
          entry: localEntry,
        });
        ownEntryUploadCounter += result.numUploaded;
      }
      debug && log.debug(`Uploaded ${ownEntryUploadCounter} local oplog entries.`);

      debug && log.debug(`Attempting to discover remote clients on server and download their oplog entries...`);
      for await (const clientRecord of plugin.getRemoteClientRecords({ excludeClientIds: [localClientId] })) {
        const remoteClientId = clientRecord.clientId;

        // What is the most recent oplog entry time we know of for the current remote client?
        let mostRecentKnownOplogTimeForRemoteClient = null;
        try {
          let mostRecentEntry = await db.getMostRecentEntryForClient(remoteClientId);
          if (mostRecentEntry) {
            mostRecentKnownOplogTimeForRemoteClient = new Date(HLTime.parse(mostRecentEntry.hlcTime).millis());
          }
        } catch (error) {
          log.error(`Error on attempt to determine most recent oplog entry time for client ${remoteClientId}`, error);
        }

        let remoteEntryDownloadCounter = 0;
        for await (const remoteEntry of plugin.getRemoteEntries({
          clientId: remoteClientId,
          afterTime: mostRecentKnownOplogTimeForRemoteClient,
        })) {
          db.applyOplogEntry(remoteEntry); // Note that this will increment the local HLC time.
          remoteEntryDownloadCounter++;
        }
        log.debug(`Downloaded ${remoteEntryDownloadCounter} oplog entries for remote client '${remoteClientId}'.`);
      }

      //TODO: Save any plugin settings that may have changed as part of the sync (e.g., the plugin updated its info
      // about the last oplog entry that was uploaded).
      const syncProfile = { ...getSyncProfileForPlugin(pluginId) } as SyncProfile;
      syncProfile.settings = plugin.getSettings();
      saveSyncProfile(syncProfile);
    } catch (error) {
      log.error(`Error while attempting to sync with ${pluginId}:`, error);
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
    saveSyncProfile({
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

export async function saveSyncProfile(profile: SyncProfile) {
  debug && log.debug(`Saving sync profile for '${profile.pluginId}'`);
  const settings = { ...db.getSettings() };
  // Remove any existing instance of the sync profile in case it already exists and we're replacing it.
  settings.syncProfiles = settings.syncProfiles.filter((existing) => existing.pluginId !== profile.pluginId);
  settings.syncProfiles.push(profile);
  await db.saveSettings(settings);
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

  if (!(candidate.isLoaded instanceof Function)) {
    return false;
  }

  if (!(candidate.load instanceof Function)) {
    return false;
  }

  if (!(candidate.isSignedIn instanceof Function)) {
    return false;
  }

  if (!(candidate.signIn instanceof Function)) {
    return false;
  }

  if (!(candidate.signOut instanceof Function)) {
    return false;
  }

  if (!(candidate.addSignInChangeListener instanceof Function)) {
    return false;
  }

  if (!(candidate.getSettings instanceof Function)) {
    return false;
  }

  if (!(candidate.setSettings instanceof Function)) {
    return false;
  }

  if (!(candidate.getRemoteEntries instanceof Function)) {
    return false;
  }

  if (!(candidate.saveRemoteEntry instanceof Function)) {
    return false;
  }

  if (!(candidate.getRemoteClientRecords instanceof Function)) {
    return false;
  }

  if (!(candidate.saveRemoteClientRecord instanceof Function)) {
    return false;
  }

  if (!(candidate.getMostRecentUploadedEntryTime instanceof Function)) {
    return false;
  }

  return true;
}
