**Installs.** To get dependencies for a fresh checkout, run `dep-archive ensure` instead of `npm ci`: it restores a lockfile-keyed archive in seconds and runs the same `npm ci` on a miss.
Exit 3 means a `node_modules` is a symlink into another checkout: stop and report it. Exit 4 is a real install failure: read it, do not retry in a loop.
Adding, removing or upgrading a dependency still goes through the package manager and this repository's lockfile rules.
