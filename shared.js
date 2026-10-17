// Loaded by the content script, the page script and the options page.
var GHPT = (function () {
  const DEFAULTS = {
    // Label of the tab that opens first on a PR; empty means All.
    defaultTab: '',
    tabs: [
      { label: 'Source', patterns: ['!Metadata', '!Tests', '!Docs', '!Infra', '!Artifacts'] },
      {
        label: 'Tests',
        patterns: [
          // Test folders anywhere in the path.
          '/(^|\\/)(__tests__|__snapshots__|__mocks__|tests?|specs?|e2e|testdata|testing)\\//i',
          // Test files by name.
          '*.test.*', '*.spec.*', '*_test.go', '*_test.py', 'test_*.py', 'conftest.py',
          '*Test.java', '*Tests.java', '*Test.kt', '*Tests.cs', '*_spec.rb', '*.snap',
          // Test config and setup aren't tests.
          '!jest.config.*', '!jest.setup.*', '!vitest.config.*', '!vitest.workspace.*',
          '!playwright.config.*', '!cypress.config.*', '!karma.conf.*', '!.mocharc*',
          '!pytest.ini', '!tox.ini', '!.nycrc*', '!setupTests.*', '!tsconfig*.json',
          '!Metadata'
        ]
      },
      {
        label: 'Docs',
        patterns: [
          // Markdown and other doc markup, except inside test folders (e.g. snapshot fixtures).
          // Readmes and changelogs belong to Metadata.
          '/^(?!.*(^|\\/)(__tests__|__snapshots__|tests?|fixtures?|testdata)\\/).*\\.(md|markdown|rst|adoc)$/i',
          '!Metadata'
        ]
      },
      {
        label: 'Infra',
        patterns: [
          // Infrastructure folders anywhere in the path.
          '/(^|\\/)(infra|infrastructure|cdk|serverless|terraform|cloudformation|deploy|deployment|deployments|k8s|kubernetes|helm|charts|\\.circleci)\\//i',
          '/(^|\\/)\\.github\\/(workflows|actions)\\//',
          'serverless.yml', 'serverless.yaml', 'serverless.ts', 'serverless.js', 'serverless.json', 'serverless.*.yml',
          'cdk.json', 'cdk.context.json', '*-stack.ts', '*-stack.js', '*.stack.ts',
          'template.yaml', 'template.yml', 'samconfig.toml',
          'Pulumi.yaml', 'Pulumi.*.yaml', '*.tf', '*.tfvars', '*.hcl',
          'Dockerfile', 'Dockerfile.*', '*.dockerfile', '.dockerignore',
          'docker-compose*.yml', 'docker-compose*.yaml', 'compose.yml', 'compose.yaml',
          'Jenkinsfile', '.gitlab-ci.yml', 'buildspec.yml', 'buildspec.yaml', 'Procfile', 'fly.toml'
        ]
      },
      {
        label: 'Metadata',
        patterns: [
          'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
          'requirements.txt', 'Pipfile', 'Pipfile.lock', 'pyproject.toml', 'poetry.lock',
          'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'Gemfile', 'Gemfile.lock',
          'composer.json', 'composer.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts',
          // Readmes and changelogs: doc extensions only (optionally localized, e.g. README.zh-CN.md),
          // so source files like readmeParser.ts or changes.ts stay out.
          '/(^|\\/)(readme|changelog|changes|history|release[-_]notes)(\\.[a-z]{2}([-_][a-z]{2})?)?\\.(md|markdown|mdx|rst|txt|adoc)$/i',
          '/(^|\\/)(readme|changelog|changes)$/i'
        ]
      },
      {
        label: 'Artifacts',
        patterns: [
          // Build output and generated-code folders anywhere in the path.
          '/(^|\\/)(dist|out|target|obj|coverage|\\.next|__generated__|generated|gen)\\//i',
          // Minified and bundled output, source maps.
          '*.min.js', '*.min.css', '*.min.mjs', '*.bundle.js', '*.chunk.js', '*.map',
          // Compiled binaries and bytecode.
          '*.pyc', '*.class', '*.jar', '*.war', '*.wasm', '*.o', '*.a', '*.so', '*.dylib', '*.dll', '*.exe',
          // Generated code (protobuf, Go, Dart, ...).
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

  // Pattern syntax: "/regex/flags" tests the full path. Otherwise a glob where * is any
  // characters (including "/") and ? is one character. A glob without "/" tests the file
  // name only, a glob with "/" tests the full path. Globs are case-insensitive.
  // A leading "!" excludes: "!Metadata" removes files that belong to the tab labelled
  // Metadata, and "!*.md" or "!/docs/i" removes files matching that pattern. A tab holds a
  // file when any plain pattern matches (or it has none) and no "!" pattern matches.
  function compile(pattern) {
    let text = pattern.trim();
    let regexForm = text.match(/^\/(.+)\/([a-z]*)$/);
    if (regexForm) {
      try {
        let re = new RegExp(regexForm[1], regexForm[2]);
        return { test: (path) => re.test(path) };
      } catch (e) {
        return null;
      }
    }
    if (!text) {
      return null;
    }
    let source = text.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    let re = new RegExp('^' + source + '$', 'i');
    let fullPath = text.includes('/');
    return {
      test: (path) => re.test(fullPath && path || path.split('/').pop())
    };
  }

  function compileConfig(config) {
    let labels = config.tabs.map((tab) => tab.label.trim().toLowerCase());
    return config.tabs.map((tab) => {
      let include = [];
      let exclude = [];
      for (let raw of tab.patterns) {
        let text = raw.trim();
        if (!text.startsWith('!')) {
          let matcher = compile(text);
          if (matcher) {
            include.push(matcher);
          }
          continue;
        }
        let rest = text.slice(1).trim();
        let ref = labels.indexOf(rest.toLowerCase());
        if (ref !== -1) {
          exclude.push({ tab: ref });
          continue;
        }
        let matcher = compile(rest);
        if (matcher) {
          exclude.push({ matcher });
        }
      }
      return { label: tab.label, include, exclude };
    });
  }

  // Returns the set of tab indexes that hold the path.
  function classify(compiled, path) {
    let cache = new Map();
    function holds(index, visiting) {
      if (cache.has(index)) {
        return cache.get(index);
      }
      if (visiting.has(index)) {
        return false;
      }
      visiting.add(index);
      let tab = compiled[index];
      let result = tab.include.length === 0 || tab.include.some((m) => m.test(path));
      for (let rule of tab.exclude) {
        if (result && rule.matcher && rule.matcher.test(path)) {
          result = false;
        }
        if (result && rule.tab !== undefined && holds(rule.tab, visiting)) {
          result = false;
        }
      }
      visiting.delete(index);
      cache.set(index, result);
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
