import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { getAuditLog, listApplicants, listApplications, listMyApplications, listNotifications, listPrograms, listStaffFeed, type ApplicantEntry } from '@workspace/api-client-react';
import type { Application, AuditEvent, Grant, StaffEvent, Tier } from '@workspace/domain/model';
import {
  adoptServerActivity, adoptServerApplicants, adoptServerApplications, adoptServerPrograms, leaveServerActivity, leaveServerApplicants, leaveServerApplications,
  type ServerAccount, type ServerApplicant,
} from '@workspace/domain/sync';
import { useSession } from './session';
import { useDemoStore } from './store';

// Records that already live on the server (phase 12). Once someone is signed in,
// grant programs and applications (an applicant's own, or the staff review
// queue), plus the applicant directory for staff, come from the API and are
// loaded into the browser store, which every page reads. Without sign-in
// configured, the store's demo data is used.

type ServerData = {
  /** True when signed in, so program changes go to the API instead of this browser. */
  connected: boolean;
  /** Set when the last program load failed; pages keep showing the previous copy. */
  programsError: string | null;
  refreshPrograms: () => Promise<void>;
  /** Staff: set when the last directory load failed. */
  applicantsError: string | null;
  refreshApplicants: () => Promise<void>;
  applicationsError: string | null;
  refreshApplications: () => Promise<void>;
  /** The signed-in account's id: applications with this applicant id are the viewer's own. */
  ownId: string | undefined;
  refreshActivity: () => Promise<void>;
  /** Staff with audit.view: whether the server's audit hash chain checked out on the last load. */
  auditChain: { intact: boolean; checked: number; brokenAt?: string } | null;
};

const Ctx = createContext<ServerData>({
  connected: false, programsError: null, refreshPrograms: async () => {}, applicantsError: null, refreshApplicants: async () => {},
  applicationsError: null, refreshApplications: async () => {}, ownId: undefined, refreshActivity: async () => {}, auditChain: null,
});

/** A directory entry from the API in the shape the store takes. */
export const toServerApplicant = ({ id, profile }: ApplicantEntry): ServerApplicant => ({
  id, profile: { ...profile, tier: profile.tier as Tier }, account: profile.account as ServerAccount,
});

/** The API's own message for a failed call, if it sent one. */
export function apiError(err: unknown, fallback: string): { error: string; fieldErrors?: Record<string, string>; status?: number } {
  const { data, status } = err as { data?: { error?: unknown; fieldErrors?: unknown }; status?: number };
  const error = typeof data?.error === 'string' ? data.error : fallback;
  const fieldErrors = data?.fieldErrors && typeof data.fieldErrors === 'object' ? data.fieldErrors as Record<string, string> : undefined;
  return { error, fieldErrors, status };
}

export function ServerDataProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const { run } = useDemoStore();
  const connected = session.status === 'signedIn';
  const [programsError, setProgramsError] = useState<string | null>(null);
  const [applicantsError, setApplicantsError] = useState<string | null>(null);
  const request = useRef(0);
  const directoryRequest = useRef(0);
  const applicationsRequest = useRef(0);
  const [applicationsError, setApplicationsError] = useState<string | null>(null);
  const ownId = connected ? session.me?.user.id : undefined;
  const activityRequest = useRef(0);
  const [auditChain, setAuditChain] = useState<ServerData['auditChain']>(null);
  const isStaff = connected && !!session.me?.staff?.active;
  const canAudit = isStaff && !!session.me?.permissions.includes('audit.view');
  // Staff see drafts and applicants don't, so reload whenever the signed-in person changes.
  const who = connected ? `${session.accountEmail}|${session.me?.staff?.id ?? ''}` : '';

  const refreshPrograms = useCallback(async () => {
    if (!connected) return;
    const id = ++request.current;
    try {
      const grants = await listPrograms();
      if (id !== request.current) return;
      run(s => adoptServerPrograms(s, grants as Grant[]));
      setProgramsError(null);
    } catch (err) {
      if (id === request.current) setProgramsError(apiError(err, "Couldn't load the latest grant programs. Showing the last copy.").error);
    }
  }, [connected, run]);

  const refreshApplicants = useCallback(async () => {
    if (!isStaff) return;
    const id = ++directoryRequest.current;
    try {
      const applicants = await listApplicants();
      if (id !== directoryRequest.current) return;
      run(s => adoptServerApplicants(s, applicants.map(toServerApplicant)));
      setApplicantsError(null);
    } catch (err) {
      if (id === directoryRequest.current) setApplicantsError(apiError(err, "Couldn't load the applicant directory.").error);
    }
  }, [isStaff, run]);

  // Staff get the review queue; an applicant gets their own applications, moved into the portal's slot.
  const refreshApplications = useCallback(async () => {
    if (!connected || !session.me) return;
    const id = ++applicationsRequest.current;
    try {
      const apps = (isStaff ? await listApplications() : await listMyApplications()) as Application[];
      if (id !== applicationsRequest.current) return;
      run(s => adoptServerApplications(s, apps, isStaff ? undefined : ownId));
      setApplicationsError(null);
    } catch (err) {
      if (id === applicationsRequest.current) setApplicationsError(apiError(err, "Couldn't load applications. Showing the last copy.").error);
    }
  }, [connected, isStaff, ownId, run, session.me]);

  // Applicants get their notifications; staff get the team feed and, with audit.view, the audit log.
  const refreshActivity = useCallback(async () => {
    if (!connected || !session.me) return;
    const id = ++activityRequest.current;
    try {
      if (!isStaff) {
        const notifications = await listNotifications();
        if (id === activityRequest.current) run(s => adoptServerActivity(s, { notifications }));
        return;
      }
      const [staffFeed, audit] = await Promise.all([listStaffFeed(), canAudit ? getAuditLog() : Promise.resolve(null)]);
      if (id !== activityRequest.current) return;
      run(s => adoptServerActivity(s, { staffFeed: staffFeed as StaffEvent[], ...(audit ? { audit: audit.events as AuditEvent[] } : {}) }));
      setAuditChain(audit?.chain ?? null);
    } catch { /* keep the last copy; the next refresh tries again */ }
  }, [canAudit, connected, isStaff, run, session.me]);

  useEffect(() => { void refreshPrograms(); }, [refreshPrograms, who]);
  useEffect(() => {
    if (!connected) { if (session.status !== 'loading') run(leaveServerActivity); return; }
    void refreshActivity();
    const timer = window.setInterval(() => { void refreshActivity(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [connected, refreshActivity, run, session.status, who]);
  useEffect(() => {
    if (connected) void refreshApplications();
    else if (session.status !== 'loading') run(leaveServerApplications);
  }, [connected, refreshApplications, run, session.status, who]);
  useEffect(() => {
    // Real applicants are only for signed-in staff; anyone else goes back to the demo directory.
    if (isStaff) void refreshApplicants();
    else if (session.status !== 'loading') run(leaveServerApplicants);
  }, [isStaff, refreshApplicants, run, session.status, who]);

  // Pick up changes other staff made while this tab was in the background.
  useEffect(() => {
    if (!connected) return;
    const onFocus = () => { void refreshPrograms(); void refreshApplicants(); void refreshApplications(); void refreshActivity(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [connected, refreshPrograms, refreshApplicants, refreshApplications, refreshActivity]);

  return <Ctx.Provider value={{ connected, programsError, refreshPrograms, applicantsError, refreshApplicants, applicationsError, refreshApplications, ownId, refreshActivity, auditChain }}>{children}</Ctx.Provider>;
}

export const useServerData = () => useContext(Ctx);
