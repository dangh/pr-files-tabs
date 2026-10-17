// Loaded by the content script, the page script and the options page.
var GHPT = (function () {
  const DEFAULTS = {
    // Label of the tab that opens first on a PR; empty means All.
    defaultTab: '',
    // Patterns use gitignore syntax (see compile). "#" lines are comments shown on the options page.
    tabs: [
      { label: 'Source', patterns: ['# Everything the other tabs don\'t claim.', '!Manifest', '!Tests', '!Docs', '!Infra', '!Artifacts'] },
      {
        label: 'Tests',
        patterns: [
          '# Test folders, anywhere.',
          '__tests__/', '__snapshots__/', '__mocks__/', 'test/', 'tests/', 'spec/', 'specs/', 'e2e/', 'testdata/', 'testing/',
          '# Test files by name.',
          '*.test.*', '*.spec.*', '*_test.go', '*_test.py', 'test_*.py', 'conftest.py',
          '*Test.java', '*Tests.java', '*Test.kt', '*Tests.cs', '*_spec.rb', '*.snap',
          '# Test config and setup aren\'t tests.',
          '!jest.config.*', '!jest.setup.*', '!vitest.config.*', '!vitest.workspace.*',
          '!playwright.config.*', '!cypress.config.*', '!karma.conf.*', '!.mocharc*',
          '!pytest.ini', '!tox.ini', '!.nycrc*', '!setupTests.*', '!tsconfig*.json',
          '!Manifest'
        ]
      },
      {
        label: 'Docs',
        patterns: [
          '# Markdown and other doc markup.',
          '*.md', '*.markdown', '*.rst', '*.adoc',
          '# Except inside test folders (snapshot fixtures) and readmes/changelogs (Manifest).',
          '!__tests__/', '!__snapshots__/', '!test/', '!tests/', '!fixture/', '!fixtures/', '!testdata/',
          '!Manifest'
        ]
      },
      {
        label: 'Infra',
        patterns: [
          '# Infrastructure folders, anywhere.',
          'infra/', 'infrastructure/', 'cdk/', 'serverless/', 'terraform/', 'cloudformation/',
          'deploy/', 'deployment/', 'deployments/', 'k8s/', 'kubernetes/', 'helm/', 'charts/', '.circleci/',
          '/.github/workflows/', '/.github/actions/',
          '# Serverless, CDK, SAM, Pulumi, Terraform.',
          'serverless.yml', 'serverless.yaml', 'serverless.ts', 'serverless.js', 'serverless.json', 'serverless.*.yml',
          'cdk.json', 'cdk.context.json', '*-stack.ts', '*-stack.js', '*.stack.ts',
          'template.yaml', 'template.yml', 'samconfig.toml',
          'Pulumi.yaml', 'Pulumi.*.yaml', '*.tf', '*.tfvars', '*.hcl',
          '# Containers and CI.',
          'Dockerfile', 'Dockerfile.*', '*.dockerfile', '.dockerignore',
          'docker-compose*.yml', 'docker-compose*.yaml', 'compose.yml', 'compose.yaml',
          'Jenkinsfile', '.gitlab-ci.yml', 'buildspec.yml', 'buildspec.yaml', 'Procfile', 'fly.toml'
        ]
      },
      {
        label: 'Manifest',
        patterns: [
          '# Dependency manifests and lock files.',
          'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
          'requirements.txt', 'Pipfile', 'Pipfile.lock', 'pyproject.toml', 'poetry.lock',
          'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'Gemfile', 'Gemfile.lock',
          'composer.json', 'composer.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts',
          '# Readmes and changelogs (doc extensions only, so readmeParser.ts stays out).',
          'README', 'CHANGELOG', 'CHANGES',
          'README*.md', 'README*.markdown', 'README*.rst', 'README*.txt', 'README*.adoc',
          'CHANGELOG*.md', 'CHANGELOG*.markdown', 'CHANGELOG*.rst', 'CHANGELOG*.txt', 'CHANGELOG*.adoc',
          'CHANGES*.md', 'CHANGES*.markdown', 'CHANGES*.rst', 'CHANGES*.txt', 'CHANGES*.adoc',
          'HISTORY*.md', 'HISTORY*.markdown', 'HISTORY*.rst', 'HISTORY*.txt', 'HISTORY*.adoc',
          'RELEASE_NOTES*.md', 'RELEASE_NOTES*.markdown', 'RELEASE_NOTES*.rst', 'RELEASE_NOTES*.txt', 'RELEASE_NOTES*.adoc'
        ]
      },
      {
        label: 'Artifacts',
        patterns: [
          '# Build output and generated-code folders, anywhere.',
          'dist/', 'out/', 'target/', 'obj/', 'coverage/', '.next/', '__generated__/', 'generated/', 'gen/',
          '# Minified and bundled output, source maps.',
          '*.min.js', '*.min.css', '*.min.mjs', '*.bundle.js', '*.chunk.js', '*.map',
          '# Compiled binaries and bytecode.',
          '*.pyc', '*.class', '*.jar', '*.war', '*.wasm', '*.o', '*.a', '*.so', '*.dylib', '*.dll', '*.exe',
          '# Generated code (protobuf, Go, Dart, ...).',
          '*.pb.go', '*.pb.gw.go', '*_pb2.py', '*_pb2_grpc.py', '*_pb.js', '*_pb.d.ts', '*_grpc_pb.js',
          'zz_generated*.go', '*_generated.go', '*.generated.*', '*.g.dart', '*.freezed.dart'
        ]
      }
    ],
    experiments: {
      // Load the open tab's diffs first (page.js, content.js). Named before it loaded whole tabs.
      onDemandDiffs: true,
      // Then load every other diff in the background so tab switches need no requests.
      backgroundLoad: true,
      // Fetch diff contents in parallel instead of GitHub's one request at a time (prefetch.js).
      parallelLoad: true
    }
  };

  // Patterns use gitignore syntax, matched case-insensitively against the file's path:
  // - No slash (`*.md`, `dist`): matches a file or folder name at any depth.
  // - A slash at the start or middle (`/build`, `docs/*.md`): relative to the repo root.
  // - A trailing slash (`test/`): folders only, i.e. every file under such a folder.
  // - `*` is anything but "/", `?` one character, `[abc]` one of a set, `**` any folders.
  // - A leading "!" excludes ("!*.md"); "!Manifest" excludes what the Manifest tab holds.
  //   "#" starts a comment; "\!" and "\#" escape a leading "!" or "#".
  // A tab's rules apply top to bottom and a later rule overrides an earlier one. A tab whose
  // first rule is a "!" (or that has no rules) starts from every file, otherwise from none.
  // Returns null for blank and comment lines.
  function compile(pattern) {
    let text = pattern.trim();
    if (!text || text.startsWith('#')) {
      return null;
    }
    if (text.startsWith('\\#') || text.startsWith('\\!')) {
      text = text.slice(1);
    }
    let folderOnly = text.endsWith('/');
    text = text.replace(/\/+$/, '');
    let anchored = text.includes('/');
    text = text.replace(/^\//, '');
    if (!text) {
      return null;
    }
    let source = '';
    for (let i = 0; i < text.length; i++) {
      let c = text[i];
      if (c === '*' && text[i + 1] === '*') {
        // "**/" is any number of folders; "**" elsewhere is anything.
        if (text[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else if (c === '*') {
        source += '[^/]*';
      } else if (c === '?') {
        source += '[^/]';
      } else if (c === '[' && text.indexOf(']', i + 2) !== -1) {
        let close = text.indexOf(']', i + 2);
        let set = text.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\');
        source += '[' + set + ']';
        i = close;
      } else if (c === '\\' && i + 1 < text.length) {
        i += 1;
        source += text[i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      } else {
        source += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      }
    }
    let re = new RegExp('^' + source + '$', 'i');
    return {
      // A pattern that matches a folder covers everything under it, so try every folder on
      // the way down, then (unless the pattern is folder-only) the file itself.
      test: function (path) {
        let parts = path.split('/');
        let last = folderOnly ? parts.length - 1 : parts.length;
        for (let n = 1; n <= last; n++) {
          if (re.test(anchored ? parts.slice(0, n).join('/') : parts[n - 1])) {
            return true;
          }
        }
        return false;
      }
    };
  }

  function compileConfig(config) {
    let labels = config.tabs.map((tab) => tab.label.trim().toLowerCase());
    return config.tabs.map((tab) => {
      let rules = [];
      for (let raw of tab.patterns) {
        let text = raw.trim();
        if (!text || text.startsWith('#')) {
          continue;
        }
        let exclude = text.startsWith('!');
        let rest = exclude ? text.slice(1).trim() : text;
        let ref = exclude ? labels.indexOf(rest.toLowerCase()) : -1;
        if (ref !== -1) {
          rules.push({ exclude, tab: ref });
          continue;
        }
        let matcher = compile(rest);
        if (matcher) {
          rules.push({ exclude, matcher });
        }
      }
      return { label: tab.label, rules, startsWithAll: rules.length === 0 || rules[0].exclude };
    });
  }

  // Returns the set of tab indexes that hold the path.
  // "!Infra" in Tests runs Infra's rules on the path and excludes it if Infra holds it. That
  // expands recursively, except that references back to a tab already being checked (Infra's
  // "!Tests" while checking Tests) are ignored, so tabs that exclude each other can't loop:
  // a file both would hold then shows in neither.
  function classify(compiled, path) {
    let memo = new Map();
    function holds(index, skip) {
      let key = index + ':' + [...skip].sort().join(',');
      if (memo.has(key)) {
        return memo.get(key);
      }
      let tab = compiled[index];
      let inner = new Set(skip).add(index);
      let result = tab.startsWithAll;
      for (let rule of tab.rules) {
        if (rule.tab === undefined) {
          if (rule.matcher.test(path)) {
            result = !rule.exclude;
          }
        } else if (result && !inner.has(rule.tab) && holds(rule.tab, inner)) {
          result = false;
        }
      }
      memo.set(key, result);
      return result;
    }
    let found = new Set();
    for (let index of compiled.keys()) {
      if (holds(index, new Set())) {
        found.add(index);
      }
    }
    return found;
  }

  async function load() {
    let stored = await chrome.storage.sync.get('config');
    let config = stored.config || DEFAULTS;
    if (config.fallbackLabel) {
      // Older saved configs had a separate catch-all tab; express it as an exclusion tab.
      let rest = config.tabs.map((tab) => '!' + tab.label);
      config = { ...config, tabs: [...config.tabs, { label: config.fallbackLabel, patterns: rest }] };
      delete config.fallbackLabel;
    }
    // Saved configs predating an experiment get its default.
    return { ...config, experiments: { ...DEFAULTS.experiments, ...config.experiments } };
  }

  // "owner/repo#123" for a PR page path, '' elsewhere.
  function prKey(pathname) {
    let match = pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!match) {
      return '';
    }
    return match[1] + '#' + match[2];
  }

  function tabList(config) {
    let list = [{ key: 'all', label: 'All' }];
    for (let [index, tab] of config.tabs.entries()) {
      list.push({ key: String(index), label: tab.label });
    }
    return list;
  }

  // The tab picked on a PR survives a refresh (sessionStorage); a PR opened fresh uses the default.
  function readSaved(pr) {
    try {
      return sessionStorage.getItem('ghpt:' + pr);
    } catch (e) {
      return null;
    }
  }

  function keyForLabel(tabs, label) {
    let tab = tabs.find((t) => t.key !== 'all' && t.label === label);
    return tab?.key;
  }

  function initialKey(config, pr) {
    let tabs = tabList(config);
    let saved = readSaved(pr);
    if (saved === 'all') {
      return 'all';
    }
    if (saved?.startsWith('tab:')) {
      let key = keyForLabel(tabs, saved.slice(4));
      if (key) {
        return key;
      }
    }
    return keyForLabel(tabs, config.defaultTab) || 'all';
  }

  return { DEFAULTS, compile, compileConfig, classify, load, prKey, tabList, initialKey };
})();
