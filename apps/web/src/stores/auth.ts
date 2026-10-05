/**
 * Session store (step 2): loads the BA session once, exposes user + role.
 *
 * PAY-8: also caches the linked employee record's employment type ("w2" /
 * "1099", null when no record exists) — the nav and route guards scope
 * worker-type-bound features (Payslips vs Invoices) from it.
 *
 * PAY-217: also keeps the access scope from GET /api/me — "w2_only" for a
 * former employee (the W-2 screen only, through w2AccessThrough). Loaded
 * right after the session, before any guard or shell code calls a refused
 * API (/api/my/profile, change requests).
 */

import { defineStore } from "pinia";
import { authClient, type SessionUser } from "../lib/auth-client";
import { ApiError, meApi, myApi } from "../lib/api";
import type { Access } from "../lib/former-access";

interface AuthState {
  user: SessionUser | null;
  loaded: boolean;
  employmentType: string | null;
  employeeLoaded: boolean;
  /** PAY-217: "w2_only" = former employee; null until loaded / signed out. */
  access: Access | null;
  /** PAY-217: last day (ISO) of the former employee's W-2 access. */
  w2AccessThrough: string | null;
}

export const useAuthStore = defineStore("auth", {
  state: (): AuthState => ({
    user: null,
    loaded: false,
    employmentType: null,
    employeeLoaded: false,
    access: null,
    w2AccessThrough: null,
  }),
  getters: {
    /** PAY-217: a former employee is never an admin here, whatever the role. */
    isAdmin: (s) => s.user?.role === "admin" && s.access !== "w2_only",
    isFormerEmployee: (s) => s.access === "w2_only",
  },
  actions: {
    /** Fetch the session at most once per page load (call refresh() to force). */
    async ensureLoaded(): Promise<void> {
      if (this.loaded) return;
      await this.refresh();
    },
    async refresh(): Promise<void> {
      try {
        const { data } = await authClient.getSession();
        this.user = (data?.user as SessionUser | undefined) ?? null;
        await this.loadAccess();
      } catch {
        this.user = null;
      } finally {
        this.loaded = true;
      }
    },
    /**
     * PAY-217: the access scope from GET /api/me. A refused /api/me (403
     * account_disabled: the W-2 window closed) means no usable session.
     */
    async loadAccess(): Promise<void> {
      this.access = null;
      this.w2AccessThrough = null;
      if (!this.user) return;
      try {
        const me = await meApi.get();
        this.access = me.access;
        this.w2AccessThrough = me.w2AccessThrough ?? null;
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) this.user = null;
        else this.access = "full";
      }
    },
    /**
     * Fetch the linked employee record's employment type at most once per
     * user (force=true re-probes, e.g. after a user switch). No linked
     * record → null (pure admin accounts, or not-yet-linked employees).
     */
    async ensureEmployee(force = false): Promise<void> {
      if (this.employeeLoaded && !force) return;
      // PAY-217: a former employee has no profile access (refused API).
      if (!this.user || this.access === "w2_only") {
        this.employmentType = null;
        this.employeeLoaded = true;
        return;
      }
      try {
        const { profile } = await myApi.profile();
        this.employmentType = profile.employmentType;
      } catch {
        this.employmentType = null;
      } finally {
        this.employeeLoaded = true;
      }
    },
    async logout(): Promise<void> {
      await authClient.signOut();
      this.user = null;
      this.employmentType = null;
      this.employeeLoaded = false;
      this.access = null;
      this.w2AccessThrough = null;
    },
  },
});
