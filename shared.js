// Loaded by the content script, the page script and the options page.
var GHPT = (function () {
  const DEFAULTS = {
    // Label of the tab that opens first on a PR; empty means All.
    defaultTab: '',
    tabs: [
      { label: 'Source', patterns: ['!Manifest', '!Tests', '!Docs', '!Infra', '!Artifacts'] },
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
          '!Manifest'
        ]
      },
      {
        label: 'Docs',
        patterns: [
          // Markdown and other doc markup, except inside test folders (e.g. snapshot fixtures).
          // Readmes and changelogs belong to Manifest.
          '/^(?!.*(^|\\/)(__tests__|__snapshots__|tests?|fixtures?|testdata)\\/).*\\.(md|markdown|rst|adoc)$/i',
          '!Manifest'
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
        label: 'Manifest',
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
  // A leading "!" excludes: "!*.md" or "!/docs/i" removes files matching that pattern, and
  // "!Manifest" removes files the tab labelled Manifest would hold (see classify).
  // A tab's rules apply top to bottom and a later rule overrides an earlier one. A tab whose
  // first rule is a "!" (or that has no rules) starts from every file, otherwise from none.
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
      let rules = [];
      for (let raw of tab.patterns) {
        let text = raw.trim();
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
