/**
 * Window Mode System Types
 *
 * Defines content modes available in workspace windows.
 * Each component manages its own state - this just tracks which mode is active.
 */

/**
 * Content modes available in workspace windows
 * - files: File tree and editor tabs
 * - agent: Agentic coding panel
 * - tracker: Tracker (bug/decision) items view
 * - collab: Shared documents
 * - pr-review: GitHub pull request review panel (issue #307)
 * - remote-sessions: Controller mode — drive sessions running on another (host) desktop
 * - settings: Settings view
 *
 * Note: org/team management is a dedicated OS window (?mode=team-management),
 * not a content mode in the project window (2026-07-17 decision-log correction).
 */
export type ContentMode = 'files' | 'agent' | 'tracker' | 'collab' | 'pr-review' | 'remote-sessions' | 'settings';
