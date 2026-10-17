// The options page, built with Kumo (Cloudflare's React components). SIFT comes from shared.js,
// loaded before this bundle.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Input, InputArea } from '@cloudflare/kumo/components/input';
import { LayerCard } from '@cloudflare/kumo/components/layer-card';
import { Link } from '@cloudflare/kumo/components/link';
import { Select } from '@cloudflare/kumo/components/select';
import { Switch } from '@cloudflare/kumo/components/switch';
import { Text } from '@cloudflare/kumo/components/text';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';

const SIFT = globalThis.SIFT;

// Select can't hold '' as a value, which is what config.defaultTab uses for All.
const ALL = '\u0000all';

// Kumo switches theme with data-mode on the root; follow the system setting.
function followSystemTheme() {
  let query = matchMedia('(prefers-color-scheme: dark)');
  let set = () => { document.documentElement.dataset.mode = query.matches ? 'dark' : 'light'; };
  set();
  query.addEventListener('change', set);
}

let nextId = 0;

function toDraft(config) {
  return {
    tabs: config.tabs.map((tab) => ({ id: nextId++, label: tab.label, patterns: tab.patterns.join('\n') })),
    defaultTab: config.defaultTab || '',
    hideEmptyTabs: config.hideEmptyTabs !== false,
    experiments: { ...config.experiments }
  };
}

function toConfig(draft) {
  return {
    tabs: draft.tabs
      .map((tab) => ({ label: tab.label.trim(), patterns: tab.patterns.split('\n').map((p) => p.trim()).filter(Boolean) }))
      .filter((tab) => tab.label),
    defaultTab: draft.defaultTab,
    hideEmptyTabs: draft.hideEmptyTabs,
    experiments: draft.experiments
  };
}

// Comments are fine; a pattern that matches nothing (e.g. a bare "!" or "/") is not.
function invalidPattern(patterns) {
  return patterns.split('\n').map((p) => p.trim()).find((p) => p && !p.startsWith('#') && !SIFT.compile(p.replace(/^!/, '')));
}

function C({ children }) {
  return <code className="rounded bg-kumo-fill px-1 py-0.5 font-mono text-[12px]">{children}</code>;
}

function Section({ title, children }) {
  return (
    <LayerCard>
      <LayerCard.Secondary>{title}</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-4 p-4">{children}</LayerCard.Primary>
    </LayerCard>
  );
}

function Help() {
  return (
    <Text variant="secondary" size="sm">
      One pattern per line, in{' '}
      <Link href="https://git-scm.com/docs/gitignore#_pattern_format" target="_blank" rel="noopener noreferrer">gitignore syntax</Link>{' '}
      (case-insensitive). Rules apply top to bottom; a later line overrides an earlier one.{' '}
      <C>*.md</C> matches a name at any depth, <C>docs/*.md</C> or <C>/build</C> is relative to the repo root,{' '}
      <C>test/</C> matches every file under a <C>test</C> folder, <C>**</C> spans folders, <C>#</C> starts a comment.
      Exclude with <C>!</C>: <C>!*.md</C> drops files matching that pattern, <C>!Manifest</C> drops files the
      Manifest tab would hold. A tab whose first line is a <C>!</C> starts from every file. Two tabs can exclude
      each other; a file both would hold then shows in neither.
    </Text>
  );
}

function TabEditor({ tab, first, last, onChange, onMove, onDelete }) {
  let invalid = invalidPattern(tab.patterns);
  return (
    <div className="flex flex-col gap-2 rounded-lg p-3 ring ring-kumo-hairline">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Tab label"
          placeholder="Tab label"
          className="flex-1"
          value={tab.label}
          onChange={(e) => onChange({ ...tab, label: e.target.value })}
        />
        <Button variant="ghost" shape="square" icon={ArrowUpIcon} aria-label="Move up" disabled={first} onClick={() => onMove(-1)} />
        <Button variant="ghost" shape="square" icon={ArrowDownIcon} aria-label="Move down" disabled={last} onClick={() => onMove(1)} />
        <Button variant="secondary-destructive" shape="square" icon={TrashIcon} aria-label="Delete tab" onClick={onDelete} />
      </div>
      <InputArea
        aria-label={'Patterns for ' + (tab.label || 'this tab')}
        className="font-mono text-[12px]"
        spellCheck={false}
        autoResize
        minRows={4}
        maxRows={16}
        value={tab.patterns}
        onValueChange={(patterns) => onChange({ ...tab, patterns })}
        error={invalid ? 'Invalid pattern: ' + invalid : undefined}
        variant={invalid ? 'error' : 'default'}
      />
    </div>
  );
}

function Toggle({ label, experimental, checked, onChange, children }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Switch label={label} checked={checked} onCheckedChange={onChange} />
        {experimental && <Badge variant="beta">Experimental</Badge>}
      </div>
      <Text variant="secondary" size="sm">{children}</Text>
    </div>
  );
}

function App({ initial }) {
  let [draft, setDraft] = useState(() => toDraft(initial));
  let [status, setStatus] = useState(null);
  let [probe, setProbe] = useState('');
  let statusTimer = useRef(null);

  let update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  let setTabs = (tabs) => update({ tabs });
  let setExperiment = (key, value) => update({ experiments: { ...draft.experiments, [key]: value } });

  function flash(text, tone) {
    setStatus({ text, tone });
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), 2500);
  }

  function move(index, by) {
    let tabs = [...draft.tabs];
    [tabs[index], tabs[index + by]] = [tabs[index + by], tabs[index]];
    setTabs(tabs);
  }

  let labels = draft.tabs.map((t) => t.label.trim()).filter(Boolean);
  // A default tab that was renamed or deleted falls back to All.
  let defaultValue = labels.includes(draft.defaultTab) ? draft.defaultTab : ALL;
  let defaultItems = { [ALL]: 'All' };
  for (let label of labels) {
    defaultItems[label] = label;
  }

  let probeResult = useMemo(() => {
    if (!probe.trim()) {
      return null;
    }
    let config = toConfig(draft);
    let held = [...SIFT.classify(SIFT.compileConfig(config), probe.trim())].map((i) => config.tabs[i].label);
    return held.length > 0 ? held.join(', ') : 'No tab (only shown under All)';
  }, [probe, draft]);

  async function save() {
    let bad = draft.tabs.map((t) => invalidPattern(t.patterns)).find(Boolean);
    if (bad) {
      flash('Invalid pattern: ' + bad, 'error');
      return;
    }
    let config = toConfig(draft);
    config.defaultTab = defaultValue === ALL ? '' : defaultValue;
    await chrome.storage.sync.set({ config });
    flash('Saved', 'success');
  }

  async function reset() {
    await chrome.storage.sync.remove('config');
    setDraft(toDraft(SIFT.DEFAULTS));
    flash('Reset to defaults', 'success');
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
      <header className="flex items-center gap-3">
        <img src="icons/icon-48.png" width="40" height="40" alt="" />
        <div>
          <Text variant="heading" size="lg" as="h1">Sift for GitHub</Text>
          <Text variant="secondary" size="sm">Tabs for GitHub pull request files</Text>
        </div>
      </header>

      <Section title="Tabs">
        <Help />
        {draft.tabs.map((tab, index) => (
          <TabEditor
            key={tab.id}
            tab={tab}
            first={index === 0}
            last={index === draft.tabs.length - 1}
            onChange={(next) => setTabs(draft.tabs.map((t) => (t.id === tab.id ? next : t)))}
            onMove={(by) => move(index, by)}
            onDelete={() => setTabs(draft.tabs.filter((t) => t.id !== tab.id))}
          />
        ))}
        <div>
          <Button icon={PlusIcon} onClick={() => setTabs([...draft.tabs, { id: nextId++, label: '', patterns: '' }])}>Add tab</Button>
        </div>
      </Section>

      <Section title="Try a path">
        <Input
          label="Path"
          placeholder="services/users/test/create.test.js"
          className="font-mono"
          value={probe}
          onChange={(e) => setProbe(e.target.value)}
          description={probeResult ? '→ ' + probeResult : 'See which tabs a file lands in with the rules above, before saving.'}
        />
      </Section>

      <Section title="Behavior">
        <Select
          label="Tab to open first on a PR"
          className="w-64"
          value={defaultValue}
          onValueChange={(value) => update({ defaultTab: value === ALL ? '' : value })}
          items={defaultItems}
          description="The tab you pick on a PR is remembered for that PR across refreshes. This only applies to PRs you open fresh."
        />
        <Toggle label="Hide tabs with no files" checked={draft.hideEmptyTabs} onChange={(hideEmptyTabs) => update({ hideEmptyTabs })}>
          Tabs that hold no files in the open PR are left out of the tab bar. All and the tab you're on always show.
        </Toggle>
      </Section>

      <Section title="Experiments">
        <Toggle label="Load the open tab first" experimental checked={draft.experiments.onDemandDiffs} onChange={(v) => setExperiment('onDemandDiffs', v)}>
          When a PR opens on a tab other than All, fetch every diff in that tab first, in large batches, instead of
          GitHub's one request at a time through the whole PR (new Files changed page).
        </Toggle>
        <Toggle label="Load the rest in the background" experimental checked={draft.experiments.backgroundLoad} onChange={(v) => setExperiment('backgroundLoad', v)}>
          Then fetch every other diff in the PR, so switching tabs is instant and makes no requests. With this off,
          only the open tab loads and other tabs load when you open them; GitHub's large-PR list is used for that, so
          Find on Page only sees diffs near the screen. The classic page always loads every diff, as GitHub does.
        </Toggle>
        <Toggle label="Parallel diff loading" experimental checked={draft.experiments.parallelLoad} onChange={(v) => setExperiment('parallelLoad', v)}>
          Fetch diffs several requests at a time instead of GitHub's one after another: large batches are split into
          parallel requests, and GitHub's own small ones are fetched ahead.
        </Toggle>
        <Text variant="secondary" size="sm">All experiments are on by default and take effect on the next page load.</Text>
      </Section>

      <footer className="sticky bottom-0 -mx-4 flex items-center gap-2 border-t border-kumo-hairline bg-kumo-recessed px-4 py-3">
        <Button variant="primary" onClick={save}>Save</Button>
        <Button variant="secondary" onClick={reset}>Reset to defaults</Button>
        {status && <Text variant={status.tone} size="sm" as="span">{status.text}</Text>}
      </footer>
    </div>
  );
}

followSystemTheme();
SIFT.load().then((config) => {
  createRoot(document.getElementById('root')).render(<App initial={config} />);
});
