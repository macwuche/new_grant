import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteDocument, getDocumentFile, listDocuments, listMyDocuments, uploadDocument, type Document as DocumentRecord, type UploadDocumentParams } from '@workspace/api-client-react';
import { apiError } from './serverData';

// Uploaded documents (signed in only). Files are stored on the API server's
// disk; the browser never keeps them, and opens them from a short-lived blob
// URL fetched with the sign-in token.

export type { DocumentRecord };
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_TYPES = 'application/pdf,image/jpeg,image/png';

export const fileSize = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** The signed-in person's own documents; `enabled` false (demo mode) loads nothing. */
export function useMyDocuments(enabled: boolean) {
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    try { setDocs(await listMyDocuments()); setError(null); } catch (err) { setError(apiError(err, "Couldn't load your documents.").error); }
  }, [enabled]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { docs, error, refresh };
}

/** Staff: an applicant's or an application's documents that the role may open. */
export function useStaffDocuments(enabled: boolean, query: { applicantId?: string; applicationId?: string }) {
  const [docs, setDocs] = useState<DocumentRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { applicantId, applicationId } = query;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    listDocuments({ ...(applicantId ? { applicantId } : {}), ...(applicationId ? { applicationId } : {}) })
      .then(d => { if (live) { setDocs(d); setError(null); } })
      .catch(err => { if (live) setError(apiError(err, "Couldn't load the documents.").error); });
    return () => { live = false; };
  }, [enabled, applicantId, applicationId]);
  return { docs, error };
}

/** Opens a document in a new tab (the tab is opened first, so popup blockers allow it). */
export async function openDocument(doc: DocumentRecord): Promise<string | null> {
  const tab = window.open('', '_blank');
  try {
    const blob = await getDocumentFile(doc.id);
    const url = URL.createObjectURL(new Blob([blob], { type: doc.contentType }));
    if (tab) tab.location.href = url;
    else { const a = document.createElement('a'); a.href = url; a.download = doc.fileName; a.click(); }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return null;
  } catch (err) {
    tab?.close();
    return apiError(err, "Couldn't open the document. Try again.").error;
  }
}

type Toast = (message: string) => void;

/** A file picker that uploads straight away. */
export function UploadButton({ params, label, onUploaded, onToast, className = 'btn btn-ghost', testId, disabled }: {
  params: UploadDocumentParams; label: string; onUploaded: (doc: DocumentRecord) => void; onToast: Toast; className?: string; testId?: string; disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file: File | undefined) => {
    if (input.current) input.current.value = '';
    if (!file) return;
    if (file.size > MAX_DOCUMENT_BYTES) { onToast('Files can be at most 10 MB.'); return; }
    setBusy(true);
    try {
      const doc = await uploadDocument(file, params, { headers: { 'X-File-Name': encodeURIComponent(file.name) } });
      onUploaded(doc);
      onToast(`${doc.fileName} uploaded.`);
    } catch (err) {
      onToast(apiError(err, "Couldn't upload the file. Try again.").error);
    } finally { setBusy(false); }
  };
  return <>
    <input ref={input} type="file" accept={ACCEPTED_TYPES} hidden onChange={e => void pick(e.target.files?.[0])} data-testid={testId ? `${testId}-input` : undefined} />
    <button type="button" className={className} disabled={busy || disabled} onClick={() => input.current?.click()} data-testid={testId}>{busy ? 'Uploading…' : label}</button>
  </>;
}

/** A list of documents with open (and, when editable, delete) actions. */
export function DocumentFiles({ docs, editable, onDeleted, onToast, buttonClass = 'btn btn-ghost', empty }: {
  docs: DocumentRecord[]; editable: boolean; onDeleted?: () => void; onToast: Toast; buttonClass?: string; empty?: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const open = async (doc: DocumentRecord) => { setBusy(doc.id); const error = await openDocument(doc); setBusy(null); if (error) onToast(error); };
  const remove = async (doc: DocumentRecord) => {
    setBusy(doc.id);
    try { onToast((await deleteDocument(doc.id)).message); onDeleted?.(); }
    catch (err) { onToast(apiError(err, "Couldn't delete the file. Try again.").error); }
    finally { setBusy(null); setConfirm(null); }
  };
  if (!docs.length) return empty ? <p className="doc-empty">{empty}</p> : null;
  return <ul className="doc-list">{docs.map(d => <li key={d.id} className="doc-row" data-testid={`row-document-${d.id}`}>
    <span className="doc-name" title={d.fileName}>{d.fileName}</span>
    <span className="doc-meta">{d.contentType === 'application/pdf' ? 'PDF' : d.contentType === 'image/png' ? 'PNG' : 'JPEG'} · {fileSize(d.sizeBytes)}</span>
    <span className="doc-actions">
      <button type="button" className={buttonClass} disabled={busy === d.id} onClick={() => void open(d)} data-testid={`button-open-document-${d.id}`}>Open</button>
      {editable && (confirm === d.id
        ? <button type="button" className={`${buttonClass} danger-text`} disabled={busy === d.id} onClick={() => void remove(d)} data-testid={`button-confirm-delete-document-${d.id}`}>Confirm delete</button>
        : <button type="button" className={buttonClass} onClick={() => setConfirm(d.id)} aria-label={`Delete ${d.fileName}`} data-testid={`button-delete-document-${d.id}`}>Delete</button>)}
    </span>
  </li>)}</ul>;
}
