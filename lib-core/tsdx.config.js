module.exports = {
  // This function will run for each entry/format/env combination. See https://tsdx.io/customization#rollup
  rollup(config, options) {
    console.log('ℹ️ [tsdx.config.js] Configuring build to NOT include external libraries (uuid, murmurhash, etc.)');
    config.external = ['uuidv4', 'murmurhash'];
    return config;
  },
};
