// Stand-in for ws's optional native modules (see build.js): failing to load makes ws use plain JS.
throw new Error("optional native module, not bundled");
