export function shouldCommitAboutBlankBeforeCdp(input: {
  windowRole: 'main' | 'popup';
  url: string;
}): boolean {
  if (input.windowRole !== 'main') return false;
  const url = String(input.url || '').trim();
  return url === '' || url === 'about:blank';
}
