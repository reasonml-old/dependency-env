#!/usr/bin/env node


var resolve = require('resolve');
var path = require('path');
var fs = require('fs');

if (process.argv.length !== 3) {
  throw new Error("Need exactly one arg to reasonLoadEnv.js");
}

var curDir = process.argv.slice(2)[0];

/**
 * We consider environment variables from devDependencies, only for the top
 * level package/app. There's still some tricky logic here because these
 * dependencies may not be installed when in production mode, so we need to
 * gracefully recover if we can't find them.
 *
 * This also means you need to be very careful when writing run scripts - never
 * assume devDependencies' environment variables will be there when running in
 * production mode.
 */
const FIRST_HOP_KEYS = [
  'devDependencies',
  'dependencies',
  'peerDependencies',
];

const SECOND_HOP_KEYS = [
  'dependencies',
  'peerDependencies',
];
var visited = {};

function resolveDep(dependency, dirs) {
    for (var dir of dirs) {
        try {
            return resolve.sync(
                path.join(dependency, 'package.json'),
                {basedir: dir}
            );
        } catch (err) { }
    }
    throw "cannot find " + dependency + " in " + dirs;
}

function traverseSync(kindsOfDependencies, absolutePathToPackageJson, handler) {
  const pkg = JSON.parse(
    fs.readFileSync(absolutePathToPackageJson, 'utf8')
  );
  kindsOfDependencies.forEach(function(key) {
    Object.keys(
      pkg[key] || {}
    ).forEach(function(dependencyName) {
      if (!visited[dependencyName]) {
        try {
          const resolved = resolveDep(dependencyName, [curDir, path.dirname(absolutePathToPackageJson)]);
          // We won't traverse transitive dependencies because this is to be used
          // only post installation, for the sake of building, and also because
          // you shouldn't be *able* to rely on binaries or environment variables
          // from dependencies you didn't model.
          visited[dependencyName] = true;
          traverseSync(SECOND_HOP_KEYS, resolved, handler);
          //
          // We might want to allow two modes, however - so that transitive
          // dependencies can build up paths for linking etc.  But if we go that
          // far, you probably want to use a custom build system anyways.
        } catch (err) {
          // We are forgiving on optional dependencies -- if we can't find them,
          // just skip them.
          // Dev dependencies won't be installed for transitive dependencies, and they
          // won't be installed for the top levle app in prod mode.
          if (pkg["optionalDependencies"] && pkg["optionalDependencies"][dependencyName] ||
              pkg["devDependencies"] && pkg["devDependencies"][dependencyName]) {
            return;
          }
          throw err;
        }
      }
    });
  });
  handler(absolutePathToPackageJson, pkg);
}


var cmds = [];
var seenVars = {};

// Transform a (key, value) pair to the form of "export key=value"
function envVarToExport(key, value) {
  return "export " + key + '="' + value + '"';
}

function traverse(filePath, packageJson) {
  var packageJsonDir = path.dirname(filePath);
  var envPaths = packageJson.exportedEnvVars;
  var packageName = packageJson.name;
  var envVarScopePrefix =
    packageName.replace(new RegExp("\-", "g"), function(s){return "_";}).toUpperCase() + "__";
  for (var envVar in envPaths) {
    if (!envPaths.hasOwnProperty(envVar)) {
      continue;
    }

    var errorPrefix = "environment variable " + envVar + " (which " + filePath + " is trying to set) ";
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
          "has already been set by " + seenVars[envVar] +
          " and " + packageName + " has configured it with globalCollisionBehavior='fail' (which is the default)."
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
    seenVars[envVar] = filePath || 'unknownPackage';
  }
}


function setUpBuiltinVariables() {
  cmds.push(envVarToExport("__dependencyEnv_sandbox", curDir));
}

setUpBuiltinVariables();
try {
  traverseSync(FIRST_HOP_KEYS, path.join(curDir, 'package.json'), traverse);
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error("Fail to find package.json!: " + err.message);
  } else {
    throw err;
  }
}
console.log(cmds.join(" && "));

/**
 * TODO: Cache this result on disk in a .reasonLoadEnvCache so that we don't
 * have to repeat this process.
 */
