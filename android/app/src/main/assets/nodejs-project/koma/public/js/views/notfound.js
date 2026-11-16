import { icon, setTitle } from '../ui.js';

export function notFound(root) {
  setTitle('Page not found');
  root.innerHTML = `<div class="lost">
    <div class="code" aria-hidden="true">404</div>
    <h1>This page doesn’t exist</h1>
    <p>The link may be broken or the page was moved. Head home or search for a title.</p>
    <a class="btn btn-primary" href="/">${icon('home')}Back to home</a>
  </div>`;
}
