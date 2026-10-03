import { useRef, useState } from 'react';
import { FileText, LoaderCircle, Paperclip, X } from 'lucide-react';
import * as api from '@workspace/api-client-react';
import { attachDepositProof, MAX_PREVIEW_PROOF_BYTES, MAX_PROOF_BYTES, MAX_PROOF_FILES, PROOF_TYPES, removeDepositProof } from '@workspace/domain/deposits';
import type { DepositProof, Transaction } from '@workspace/domain/model';
import { fileSize } from '@/lib/documents';
import { apiError, useMoneyAction, useServerData } from '@/lib/serverData';
import './DepositProof.css';

// Proof of payment for a deposit: receipts or screenshots the applicant adds
// while the deposit waits for confirmation. Signed in, files go to the API
// server and are opened from a short-lived blob URL fetched with the sign-in
// token; in the browser-only preview they're kept in this browser as small
// data: URLs.

type Toast = (message: string) => void;
const KIND: Record<string, string> = { 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPG' };

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
}
async function sha256(file: File): Promise<string> {
  try { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join(''); } catch { return ''; }
}
const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `p${Date.now()}${Math.random().toString(16).slice(2)}`);

/** Opens a proof file in a new tab (the tab is opened first, so popup blockers allow it). */
export async function openDepositProof(tx: Transaction, proof: DepositProof): Promise<string | null> {
  const tab = window.open('', '_blank');
  try {
    const blob = proof.previewUrl ? await (await fetch(proof.previewUrl)).blob() : await api.getDepositProof(tx.id, proof.id);
    const url = URL.createObjectURL(new Blob([blob], { type: proof.contentType }));
    if (tab) tab.location.href = url;
    else { const a = document.createElement('a'); a.href = url; a.download = proof.fileName; a.click(); }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return null;
  } catch (err) {
    tab?.close();
    return apiError(err, "Couldn't open the file. Try again.").error;
  }
}

/** The deposit's proof files, with open (and, for the applicant while it's pending, remove) actions. */
export function ProofFiles({ tx, editable, onToast, buttonClass, testId = 'deposit-proof' }: { tx: Transaction; editable: boolean; onToast: Toast; buttonClass: string; testId?: string }) {
  const moneyAction = useMoneyAction();
  const [busy, setBusy] = useState<string | null>(null);
  const files = tx.proof ?? [];
  if (!files.length) return null;
  const open = async (p: DepositProof) => { setBusy(p.id); const error = await openDepositProof(tx, p); setBusy(null); if (error) onToast(error); };
  const remove = async (p: DepositProof) => {
    setBusy(p.id);
    const result = await moneyAction(s => removeDepositProof(s, tx.id, p.id), () => api.removeDepositProof(tx.id, p.id));
    setBusy(null);
    onToast(result.ok ? result.message : result.error);
  };
  return <ul className="proof-list" data-testid={`list-${testId}`}>{files.map(p => <li key={p.id} className="proof-row" data-testid={`row-${testId}-${p.id}`}>
    <FileText size={15} aria-hidden="true" />
    <span className="proof-name" title={p.fileName}>{p.fileName}</span>
    <span className="proof-meta">{KIND[p.contentType] ?? 'File'} · {fileSize(p.sizeBytes)}</span>
    <span className="proof-actions">
      <button type="button" className={buttonClass} disabled={busy === p.id} onClick={() => void open(p)} data-testid={`button-open-${testId}-${p.id}`}>Open</button>
      {editable && <button type="button" className={buttonClass} disabled={busy === p.id} onClick={() => void remove(p)} aria-label={`Remove ${p.fileName}`} data-testid={`button-remove-${testId}-${p.id}`}><X size={12} /> Remove</button>}
    </span>
  </li>)}</ul>;
}

/** Picks a receipt or screenshot and adds it to the applicant's pending deposit straight away. */
export function ProofUploadButton({ tx, onToast, className, testId = 'button-upload-proof' }: { tx: Transaction; onToast: Toast; className: string; testId?: string }) {
  const { connected } = useServerData();
  const moneyAction = useMoneyAction();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const full = (tx.proof?.length ?? 0) >= MAX_PROOF_FILES;
  const pick = async (file: File | undefined) => {
    if (input.current) input.current.value = '';
    if (!file) return;
    if (!(PROOF_TYPES as readonly string[]).includes(file.type)) { onToast('Upload a PDF, JPG, or PNG file.'); return; }
    const limit = connected ? MAX_PROOF_BYTES : MAX_PREVIEW_PROOF_BYTES;
    if (file.size > limit) { onToast(`Files can be at most ${connected ? '10 MB' : '400 KB in this preview'}.`); return; }
    setBusy(true);
    const local = connected ? null : {
      id: newId(), fileName: file.name.slice(-120) || 'receipt', contentType: file.type, sizeBytes: file.size,
      sha256: await sha256(file), uploadedAt: new Date().toISOString(), previewUrl: await readAsDataUrl(file),
    } satisfies DepositProof;
    const result = await moneyAction(s => attachDepositProof(s, tx.id, local!, new Date()), () => api.uploadDepositProof(tx.id, file, { headers: { 'X-File-Name': encodeURIComponent(file.name) } }));
    setBusy(false);
    onToast(result.ok ? result.message : result.error);
  };
  return <>
    <input ref={input} type="file" accept={PROOF_TYPES.join(',')} hidden onChange={e => void pick(e.target.files?.[0])} data-testid={`${testId}-input`} />
    <button type="button" className={className} disabled={busy || full} onClick={() => input.current?.click()} data-testid={testId}>
      {busy ? <LoaderCircle size={13} className="dp-spin" /> : <Paperclip size={13} />} {busy ? 'Uploading…' : full ? `${MAX_PROOF_FILES} files added` : (tx.proof?.length ? 'Add another file' : 'Upload receipt or screenshot')}
    </button>
  </>;
}
