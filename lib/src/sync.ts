import * as db from './db';
import { HLTime } from './HLTime';
import { convertTreePathToTime } from './MerkleTree';
import { debug, libName, log } from './utils';

const plugins: SyncPlugin[] = [];

export async function sync() {
  debug && log.debug('Starting sync...');
  const { nodeId: localNodeId } = db.getSettings();

  // Note: if a serialized Merkle tree doesn't exist in IndexedDB, then this will cause it to be built from scratch
  // (which could take some time if there are thousands of entries).
  const oplogMerkle = await db.getOplogMerkleTree();

  // By deleting any merkle tree data that has been persisted to IndexedDB, we are setting up a "fail safe" condition.
  // If the runtime dies at any point before we finish syncing, preventing us from having written the updated Merkle
  // tree to IndexedDB, then the next sync attempt will be forced to rebuild the merkle from scratch.
  await db.deleteOplogMerkle();

  // It's possible that new oplog entries have been created since the last time the merkle tree was updated. Instead of
  // always re-building the merkle tree from scratch--iterating over the entire store of oplog entries--we will try to
  // only add the entries that were created since the last time the merkle was updated. Since every Merkle tree path
  // maps to a time at which some oplog entry was created (albeit in minutes, deliberately less precise than a smaller
  // unit of time, which allows the overall tree to be smaller), we can convert the path to the most recent Merkle tree
  // leaf back to a time and have an approximate time for the last / "most recent" oplog entry that was inserted into
  // the merkle. We can then quickly figure out which oplog entries were added to the local store on/after that time and
  // add them to the merkle.
  //
  // For this to work correctly, it's important that only "locally created" oplog entries were added to the store since
  // the last time the merkle was updated. The algorithm will break if, for example, the most recent merkle tree time is
  // "last week", but yesterday a bunch of month-old oplog entries from some other node were added to the local oplog
  // store. In that scenario, we would incorrectly assume that we only need to update our merkle with oplog entries from
  // the last week, when in fact, we need to go back one month.

  // It's possible that we have made local changes (i.e., new oplog entries were created) since the last time the Merkle
  // tree was updated.
  let lastMerkleDate;
  const pathToNewestMerkleLeaf = oplogMerkle.pathToNewestLeaf();
  if (pathToNewestMerkleLeaf.length > 0) {
    lastMerkleDate = new Date(convertTreePathToTime(pathToNewestMerkleLeaf));
    log.debug(`Attempting to update merkle with local oplog entries created on/after ${lastMerkleDate.toISOString()}`);
  } else {
    log.debug(`Attempting to update merkle with ALL local oplog entries`);
  }

  let counter = 0;
  for await (const localEntry of db.getEntries({ afterTime: lastMerkleDate })) {
    oplogMerkle.insertHLTime(HLTime.parse(localEntry.hlcTime));
    counter++;
  }
  log.debug(`Added ${counter} new (local) oplog entries to merkle tree.`);

  for (const plugin of plugins) {
    const pluginId = plugin.getPluginId();
    try {
      log.debug(`Attempting to sync with ${pluginId}`);

      // Establish diff time between local and remote merkle, for our own client ID
      const ownRemoteDiffDate = await plugin.getOwnRemoteDiffTime(localNodeId, oplogMerkle);

      // Upload all messages on/after that diff time
      if (ownRemoteDiffDate) {
        log.debug(`Attempting to upload entries created on/after ${ownRemoteDiffDate.toISOString()} to ${pluginId}`);
        counter = 0;
        for await (const localEntry of db.getEntries({ afterTime: lastMerkleDate })) {
          await plugin.addRemoteEntry(localEntry);
          counter++;
        }
        log.debug(`Uploaded ${counter} local oplog entries to ${pluginId}.`);
      }

      // Establish diff times between local merkle and every other node's merkle
      const otherRemoteDiffDates = await plugin.getOtherRemoteDiffTimes(localNodeId, oplogMerkle);
      for (const otherRemoteDiffDate of otherRemoteDiffDates) {
        const { nodeId, diffTime } = otherRemoteDiffDate;
        for await (const remoteEntry of plugin.getRemoteEntries({ nodeId, afterTime: diffTime })) {
          log.debug('todo: apply remote entry to local store:', remoteEntry);
          db.applyOplogEntry(remoteEntry); // Note: this will increment the local HLC time.

          // If flow of execution makes it this far, we know that at least one remote oplog entry was successfully
          // downloaded AND applied to our local oplog store, therefore it's safe to update the local merkle.
          oplogMerkle.insertHLTime(HLTime.parse(remoteEntry.hlcTime));
        }
      }
    } catch (error) {
      log.error(`Error while attempting to sync with ${pluginId}`, error);
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

  if (!(candidate.getRemoteEntries instanceof Function)) {
    return false;
  }

  if (!(candidate.addRemoteEntry instanceof Function)) {
    return false;
  }

  return true;
}
