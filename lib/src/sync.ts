import * as db from './db';
import { HLTime } from './HLTime';
import { convertTreePathToTime, MerkleTree } from './MerkleTree';
import { debug, libName, log } from './utils';

const plugins: SyncPlugin[] = [];

export async function sync() {
  debug && log.debug('Starting sync...');
  const { nodeId: localClientId } = db.getSettings();

  // If a serialized Merkle tree doesn't exist in IndexedDB, then this will cause it to be built from scratch (which
  // could take some time if there are thousands of entries).
  const ownLocalMerkle = await db.getOplogMerkleTree();

  // By deleting any merkle tree data that has been persisted to IndexedDB, we are setting up a "fail safe" condition.
  // If the runtime dies at any point before we finish syncing, preventing us from having written the updated Merkle
  // tree to IndexedDB, then the next sync attempt will be forced to rebuild the merkle from scratch.
  await db.deleteOplogMerkle();

  // Update the oplog merkle tree (since it's only updated when syncing happens and new oplog entries may have been
  // created since the last sync). We'll need to get all the entries that were created after the last sync and add them
  // to the merkle. We'll do that by assuming that the most recent oplog entry in the merkle tree represents the
  // "greatest" HLTime that this client knew about when the last sync completed, and that if this client has created any
  // new oplog entries since that sync, they were created _after_ that time (i.e., the local hybrid logical clock
  // was incremented past that time).
  let lastMerkleDate;
  const pathToNewestMerkleLeaf = ownLocalMerkle.pathToNewestLeaf();
  if (pathToNewestMerkleLeaf.length > 0) {
    lastMerkleDate = new Date(convertTreePathToTime(pathToNewestMerkleLeaf));
    log.debug(`Attempting to update merkle with local oplog entries created on/after ${lastMerkleDate.toISOString()}`);
  } else {
    log.debug(`Attempting to update merkle with ALL local oplog entries`);
  }

  let counter = 0;
  for await (const localEntry of db.getEntries({ afterTime: lastMerkleDate })) {
    ownLocalMerkle.insertHLTime(HLTime.parse(localEntry.hlcTime));
    counter++;
  }
  debug && log.debug(`Added ${counter} new (local) oplog entries to merkle tree.`);

  // Attempt to do a sync using each registered plugin
  for (const plugin of plugins) {
    const pluginId = plugin.getPluginId();
    try {
      debug && log.debug(`Attempting to sync with remote storage using '${pluginId}' plugin.`);

      // Attempt to retrieve the remote merkle for the current client. We only expect one to exist, but technically
      // we could get multiple back if something weird happened (e.g., the user duplicated a file).
      const ownRemoteMerkleCandidates = [];
      for await (const ownRemoteMerkleCandidate of plugin.getRemoteMerkles({ includeClientIds: [localClientId] })) {
        ownRemoteMerkleCandidates.push(ownRemoteMerkleCandidate);
      }

      // How/when does this client's own LOCAL merkle differ from its own REMOTE merkle on the server? Default to a date
      // that occurs far enough in the past to cause all local oplog entries to be uploaded.
      let ownLocalRemoteDiffDate: Date | null = new Date(0);
      let deleteOwnRemoteMerkles = false;

      if (ownRemoteMerkleCandidates.length === 0) {
        debug && log.debug(`No merkle trees exist on remote for current client (${localClientId}).`);
      } else if (ownRemoteMerkleCandidates.length === 1) {
        try {
          ownLocalRemoteDiffDate = findMerkleDiffDate(ownRemoteMerkleCandidates[0].merkle, ownLocalMerkle);
          if (ownLocalRemoteDiffDate) {
            log.debug(`Own LOCAL merkle differs from own REMOTE merkle at ${ownLocalRemoteDiffDate.toISOString()}`);
          } else {
            log.debug(`Own LOCAL merkle is same as own REMOTE merkle.`);
          }
        } catch (error) {
          let msg =
            `Received invalid remote merkle for current client (${localClientId}); ignoring this merkle and ` +
            `re-uploading ALL oplog entries (and a new merkle).`;
          log.warn(msg, error);
        }
      } else {
        let msg =
          `Expected to find 0 or 1 remote merkles for client ${localClientId} but found ` +
          `${ownRemoteMerkleCandidates.length}; will attempt to delete these and upload a single merkle.`;
        log.warn(msg);
        deleteOwnRemoteMerkles = true;
      }

      if (deleteOwnRemoteMerkles) {
        log.debug(`Attempting to delete all remote merkles for client '${localClientId}' using '${pluginId}'`);
        //TODO: delete all of our own remote merkle files
      }

      if (ownLocalRemoteDiffDate) {
        log.debug(`Uploading OWN local entries created after ${ownLocalRemoteDiffDate.toISOString()}.`);
        counter = 0;
        for await (const localEntry of db.getEntries({ afterTime: ownLocalRemoteDiffDate })) {
          //TODO: Add support for uploading more than one entry at a time
          let hlTime = HLTime.parse(localEntry.hlcTime);
          await plugin.saveRemoteEntry({
            time: new Date(hlTime.millis()),
            counter: hlTime.counter(),
            clientId: hlTime.node(),
            entry: localEntry,
          });
          counter++;
        }
        debug && log.debug(`Uploaded ${counter} OWN local oplog entries.`);

        // At this point we have A) updated the local merkle with the latest, local oplog entries, and B) uploaded all
        // of the client's own oplog entries that were missing from the server for the current plugin.
        plugin.saveRemoteMerkle(localClientId, ownLocalMerkle);
        db.saveOplogMerkle(ownLocalMerkle);
      } else {
        log.debug(`Own local merkle matches own remote merkle; no oplog entries need to be uploaded`);
      }

      // Download oplog entries created by other clients
      log.debug(`Attempting to discover merkles for OTHER clients on server and download their oplog entries...`);
      for await (const remoteMerkleCandidate of plugin.getRemoteMerkles({ excludeClientIds: [localClientId] })) {
        let diffDate = null;
        const { merkle: remoteMerkle, clientId: remoteClientId } = remoteMerkleCandidate;
        try {
          diffDate = findMerkleDiffDate(remoteMerkle, ownLocalMerkle);
          log.debug(`Local/remote merkle comparison results:`, { remoteMerkle, ownLocalMerkle, diffDate });
          if (diffDate) {
            log.debug(`Own merkle differs from ${remoteClientId} merkle at ${diffDate.toISOString()}`);
          } else {
            log.debug(`Own merkle is SAME as ${remoteClientId} merkle; won't download oplog entries from that client.`);
          }
        } catch (error) {
          log.warn(
            `Received invalid merkle for client ${localClientId}; downloading ALL oplog entries from that client.`,
            error
          );
        }

        let appliedRemoteEntriesCounter = 0;
        if (diffDate) {
          for await (const remoteEntry of plugin.getRemoteEntries({ clientId: remoteClientId, afterTime: diffDate })) {
            db.applyOplogEntry(remoteEntry); // Note that this will increment the local HLC time.

            // If flow of execution makes it this far, we know that at least one remote oplog entry was successfully
            // downloaded AND applied to our local oplog store, therefore it's safe to update the local merkle.
            ownLocalMerkle.insertHLTime(HLTime.parse(remoteEntry.hlcTime));

            appliedRemoteEntriesCounter++;
          }
        }

        // Don't bother uploading/saving our merkle unless we actually applied new entries.
        if (appliedRemoteEntriesCounter > 0) {
          plugin.saveRemoteMerkle(localClientId, ownLocalMerkle);
          db.saveOplogMerkle(ownLocalMerkle);
        }
      }
    } catch (error) {
      log.error(`Error while attempting to sync with ${pluginId}:`, error);
    }
  }
}

function findMerkleDiffDate(merkleCandidate: MerkleTreeCompatible, merkle2: MerkleTree): Date | null {
  const merkle1 = MerkleTree.fromObj(merkleCandidate);
  const diffPath = merkle2.findDiff(merkle1);
  if (Array.isArray(diffPath)) {
    return diffPath.length > 0 ? new Date(convertTreePathToTime(diffPath)) : new Date(0);
  } else {
    return null;
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

  if (!(candidate.saveRemoteEntry instanceof Function)) {
    return false;
  }

  return true;
}
