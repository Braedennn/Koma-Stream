// The dialogs are little pages of their own.
//
// While one is open the page behind it stands still: the focus moving inside
// the panel must not drag the page along with it, and the scroll of the panel
// must not carry on into the page when it reaches the end. On a television
// this is the difference between a panel and a hole in the screen.
//
// The world is told when a dialog opens and when it closes, so the television
// can put the focus inside the panel and take it out again.

export function initDialogs() {
  const html = document.documentElement;

  const sync = () => {
    const open = [...document.querySelectorAll('dialog[open]')];
    html.classList.toggle('dlg-open', open.length > 0);
    dispatchEvent(new CustomEvent('koma:dialog', {
      detail: { open: open.length > 0, dialog: open[open.length - 1] || null },
    }));
  };

  // The open attribute is what says a dialog is open, and it is what changes.
  new MutationObserver(sync).observe(html, { attributes: true, subtree: true, attributeFilter: ['open'] });
  sync();
}
