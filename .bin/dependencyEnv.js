#!/usr/bin/env node


var resolve = require('resolve');
var path = require('path');
var fs = require('fs');

if (process.argv.length !== 3) {
  throw new Error("Need exactly one arg to reasonLoadEnv.js");
}

var curDir = process.argv.slice(2)[0];

const KEYS = [
  'dependencies',
  'optDependencies',
  'peerDependencies',
];

var visited = {};

function traverseSync(filename, handler) {
  const pkg = JSON.parse(
    fs.readFileSync(filename, 'utf8')
  );
  handler(filename, pkg);
  KEYS.forEach(function(key) {
    Object.keys(
      pkg[key] || {}
    ).forEach(function(dependency) {
      var pJson = path.join(dependency, 'package.json');
      if (!visited[pJson]) {
        try {
          const resolved = resolve.sync(
            path.join(dependency, 'package.json'),
            {basedir: path.join(curDir, 'node_modules')}
          );
          // We won't traverse transitive dependencies because this is to be used
          // only post installation, for the sake of building, and also because
          // you shouldn't be *able* to rely on binaries or environment variables
          // from dependencies you didn't model.
          traverseSync(resolved, handler);
          //
          // We might want to allow two modes, however - so that transitive
          // dependencies can build up paths for linking etc.  But if we go that
          // far, you probably want to use a custom build system anyways.
          visited[pJson] = true;          
        } catch (err) {
          // We are forgiving on optional dependencies -- if we can't find them,
          // just skip them
          if (key == "optDependencies") {              
            return;
          }
          throw err;
        }
      }
    });
  });
}


var cmds = [];
var seenVars = {};
traverseSync(path.join(curDir, 'package.json'), function(filePath, packageJson) {
  var packageJsonDir = path.dirname(filePath);
  var envPaths = packageJson.exportedEnvVars;
  var packageName = packageJson.name;
  var envVarScopePrefix =
    packageName.replace(new RegExp("\-", "g"), function(s){return "_";}).toUpperCase() + "__";
  for (var envVar in envPaths) {
    if (!envPaths.hasOwnProperty(envVar)) {
      continue;
    }

    var errorPrefix = "environment variable " + envVar + " from dependency package " + filePath;
    var config = envPaths[envVar];
    if (!config.global) {
      if (envVar.indexOf(envVarScopePrefix) !== 0) {
        throw new Error(
          errorPrefix +
            " doesn't begin with " + envVarScopePrefix + " yet it is not marked as 'global'. The package" +
            "owner for " + packageName + " likely made a mistake."
        );
      }
    } else {
      // Else, it's global, but better not be trying to step on another package!
      if (envVar.indexOf("__") !== -1) {
        throw new Error(
          errorPrefix +
            " is a global environment variable, but it looks like it's trying to step on a " +
            " package because it has a double underscore - which is how we express namespaced env vars." +
            "The package owner for " + packageName + " likely made a mistake."
        );
      }
    }
    var normalizedVal = config.resolveAsRelativePath ? path.resolve(packageJsonDir, config.val) : config.val;

    // The seenVars will only cover the cases when another package declares the variable, not when it's loaded
    // from your bashrc etc.
    if (seenVars[envVar] && (config.globalCollisionBehavior === 'fail' || config.globalCollisionBehavior == null)) {
      throw new Error(
        errorPrefix +
          " is a global environment variable that has already been set by some other package and " +
          "it is configured with " +
          "globalCollisionBehavior='fail' (which is the default behavior)."
      );
    }
    if (config.globalCollisionBehavior === 'fail' ||
        config.globalCollisionBehavior == null ||
        config.globalCollisionBehavior === 'clobber') {
      cmds.push("export " + envVar + '="' + normalizedVal + '"');
    } else if (config.globalCollisionBehavior === 'joinPath') {
      cmds.push("export " + envVar + '="' + normalizedVal + ":$" + envVar + '"');
    } else {
      throw new Error(
        errorPrefix +
          " is configured with an unknown globalCollisionBehavior:" +
          config.globalCollisionBehavior + "."
      );
    }
    seenVars[envVar] = true;
  }
});
console.log(cmds.join(" && "));

/**
 * TODO: Cache this result on disk in a .reasonLoadEnvCache so that we don't
 * have to repeat this process.
 */