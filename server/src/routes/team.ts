/**
 * team.ts — Team-tier routes.
 *
 *   POST /team/create        — create a team (requires tier=team)
 *   GET  /team/members       — list members of the caller's team
 *   GET  /team/invites       — list pending invites for the caller's team (admin only)
 *   POST /team/invite        — send a magic-link invite to an email (admin only)
 *   POST /team/invites/:token/revoke  — revoke a pending invite (admin only)
 *   POST /team/accept-invite — accept an invite (authenticated user)
 *
 * Role enforcement: invite/revoke require admin role on the team; everything
 * else requires any membership. Creating a team demands tier=team.
 */

import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware, requireTier } from "../lib/auth.js";
import { sendEmail } from "../lib/email.js";
import {
  createTeam,
  createTeamInvite,
  getTeamForUser,
  listTeamInvites,
  listTeamMembers,
  acceptTeamInvite,
  revokeTeamInvite,
} from "../db.js";

const FRONTEND_URL = process.env["FRONTEND_URL"] ?? "https://plugin.ashlr.ai";

const router = new Hono();

router.use("/team/*", authMiddleware);

// ---------------------------------------------------------------------------
// POST /team/create
// ---------------------------------------------------------------------------

const createSchema = z.object({
  name: z.string().min(1).max(80),
});

router.post("/team/create", async (c) => {
  const user = c.get("user");
  const tierDeny = requireTier(c, user, "team");
  if (tierDeny) return tierDeny;

  if (getTeamForUser(user.id)) {
    return c.json({ error: "You are already a member of a team." }, 409);
  }

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Team name is required (1-80 chars)." }, 400);

  const team = createTeam(parsed.data.name, user.id);
  return c.json({ team });
});

// ---------------------------------------------------------------------------
// GET /team/members
// ---------------------------------------------------------------------------

router.get("/team/members", (c) => {
  const user = c.get("user");
  const membership = getTeamForUser(user.id);
  if (!membership) return c.json({ error: "Not a team member." }, 404);
  const members = listTeamMembers(membership.team.id);
  return c.json({
    team: membership.team,
    role: membership.role,
    members: members.map((m) => ({
      user_id:   m.user_id,
      email:     m.email,
      role:      m.role,
      joined_at: m.joined_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /team/invites
// ---------------------------------------------------------------------------

router.get("/team/invites", (c) => {
  const user = c.get("user");
  const membership = getTeamForUser(user.id);
  if (!membership) return c.json({ error: "Not a team member." }, 404);
  if (membership.role !== "admin") return c.json({ error: "Admin role required." }, 403);

  const invites = listTeamInvites(membership.team.id);
  return c.json({
    invites: invites.map((i) => ({
      token:      i.token,
      email:      i.email,
      role:       i.role,
      expires_at: i.expires_at,
      created_at: i.created_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /team/invite
// ---------------------------------------------------------------------------

const inviteSchema = z.object({
  email: z.string().email().max(254),
  role: z.enum(["admin", "member"]).default("member"),
});

router.post("/team/invite", async (c) => {
  const user = c.get("user");
  const membership = getTeamForUser(user.id);
  if (!membership) return c.json({ error: "Not a team member." }, 404);
  if (membership.role !== "admin") return c.json({ error: "Admin role required." }, 403);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }

  const parsed = inviteSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid email or role." }, 400);

  const invite = createTeamInvite({
    teamId: membership.team.id,
    email: parsed.data.email,
    role: parsed.data.role,
    invitedBy: user.id,
  });

  const link = `${FRONTEND_URL}/team/accept?token=${invite.token}`;
  try {
    await sendEmail("team-invite", {
      to: parsed.data.email,
      data: {
        email: parsed.data.email,
        teamName: membership.team.name,
        inviterEmail: user.email,
        role: parsed.data.role,
        link,
      },
    });
  } catch (err) {
    process.stderr.write(`[ashlr-team] invite email failed: ${String(err)}\n`);
    // Don't leak failure to caller. Invite is already persisted and link is returned.
  }

  return c.json({ invite: { token: invite.token, email: invite.email, role: invite.role, expires_at: invite.expires_at }, link });
});

// ---------------------------------------------------------------------------
// POST /team/invites/:token/revoke
// ---------------------------------------------------------------------------

router.post("/team/invites/:token/revoke", (c) => {
  const user = c.get("user");
  const membership = getTeamForUser(user.id);
  if (!membership) return c.json({ error: "Not a team member." }, 404);
  if (membership.role !== "admin") return c.json({ error: "Admin role required." }, 403);

  const token = c.req.param("token");
  revokeTeamInvite(token);
  return c.json({ revoked: true });
});

// ---------------------------------------------------------------------------
// POST /team/accept-invite
// ---------------------------------------------------------------------------

const acceptSchema = z.object({ token: z.string().min(16) });

router.post("/team/accept-invite", async (c) => {
  const user = c.get("user");
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }

  const parsed = acceptSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invite token required" }, 400);

  if (getTeamForUser(user.id)) {
    return c.json({ error: "You are already a member of a team." }, 409);
  }

  const membership = acceptTeamInvite(parsed.data.token, user.id);
  if (!membership) return c.json({ error: "invalid or expired invite" }, 400);

  return c.json({ membership });
});

export default router;
