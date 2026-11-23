export function initAnalyticsTabs({ onModeChange }) {
  const shell = document.getElementById('analyticsTabs');
  const chartStage = document.getElementById('chartStage');
  if (!shell) {
    return null;
  }

  const tabs = Array.from(shell.querySelectorAll('[role="tab"]'));
  const panels = Array.from(shell.querySelectorAll('[role="tabpanel"]'));

  function selectTab(targetTab, { moveFocus = false } = {}) {
    const targetPanelId = targetTab.dataset.panel;
    const mode = targetTab.dataset.mode || 'realtime';

    tabs.forEach((tab) => {
      const isSelected = tab === targetTab;
      tab.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      tab.toggleAttribute('focusgroupstart', isSelected);
      if (isSelected) {
        tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    });

    panels.forEach((panel) => {
      const active = panel.id === targetPanelId;
      if (active) {
        panel.removeAttribute('hidden');
        const hasFocusable = panel.querySelector('button, input, select, a, [tabindex]');
        if (!hasFocusable) {
          panel.setAttribute('tabindex', '0');
        }
      } else {
        panel.setAttribute('hidden', 'until-found');
        panel.removeAttribute('tabindex');
      }
    });

    if (chartStage) {
      chartStage.hidden = mode === 'comparison';
    }

    if (moveFocus) {
      targetTab.focus();
    }

    if (typeof onModeChange === 'function') {
      onModeChange(mode);
    }
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      selectTab(tab);
    });

    // Keyboard arrow fallback for browsers without native focusgroup
    tab.addEventListener('keydown', (event) => {
      const idx = tabs.indexOf(tab);
      let nextIdx = -1;
      if (event.key === 'ArrowRight') {
        nextIdx = (idx + 1) % tabs.length;
      } else if (event.key === 'ArrowLeft') {
        nextIdx = (idx - 1 + tabs.length) % tabs.length;
      } else if (event.key === 'Home') {
        nextIdx = 0;
      } else if (event.key === 'End') {
        nextIdx = tabs.length - 1;
      }
      if (nextIdx !== -1) {
        event.preventDefault();
        selectTab(tabs[nextIdx], { moveFocus: true });
      }
    });
  });

  // Reveal tab automatically when Ctrl+F matches inside a hidden=until-found panel
  panels.forEach((panel) => {
    panel.addEventListener('beforematch', () => {
      const matchingTab = tabs.find((t) => t.dataset.panel === panel.id);
      if (matchingTab) {
        selectTab(matchingTab);
      }
    });
  });

  return { selectTab, tabs };
}
