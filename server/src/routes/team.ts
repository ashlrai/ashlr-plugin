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

import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware, requireTier } from "../lib/auth.js";
import { sendEmail } from "../lib/email.js";
import {
  createTeam,
  createTeamInvite,
  getTeamForUser,
  getTeamInvite,
  listTeamInvites,
  listTeamMembers,
  acceptTeamInvite,
  revokeTeamInvite,
} from "../db.js";

const FRONTEND_URL = process.env["FRONTEND_URL"] ?? "https://plugin.ashlr.ai";

const router = new Hono();

router.use("/team/*", authMiddleware);

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

type Membership = NonNullable<ReturnType<typeof getTeamForUser>>;
type Guard<T> = { ok: T } | { deny: Response };

/** Resolve the caller's team membership or return a 404 response. */
function requireMembership(c: Context, userId: string): Guard<Membership> {
  const membership = getTeamForUser(userId);
  if (!membership) return { deny: c.json({ error: "Not a team member." }, 404) };
  return { ok: membership };
}

/** Require the caller to be a team admin (membership + role check). */
function requireTeamAdmin(c: Context, userId: string): Guard<Membership> {
  const guard = requireMembership(c, userId);
  if ("deny" in guard) return guard;
  if (guard.ok.role !== "admin") {
    return { deny: c.json({ error: "Admin role required." }, 403) };
  }
  return guard;
}

/** Parse the request body as JSON or return a 400 response. */
async function parseJsonBody(c: Context): Promise<Guard<unknown>> {
  try {
    return { ok: await c.req.json() };
  } catch {
    return { deny: c.json({ error: "Invalid JSON" }, 400) };
  }
}

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

  const body = await parseJsonBody(c);
  if ("deny" in body) return body.deny;

  const parsed = createSchema.safeParse(body.ok);
  if (!parsed.success) return c.json({ error: "Team name is required (1-80 chars)." }, 400);

  const team = createTeam(parsed.data.name, user.id);
  return c.json({ team });
});

// ---------------------------------------------------------------------------
// GET /team/members
// ---------------------------------------------------------------------------

router.get("/team/members", (c) => {
  const user = c.get("user");
  const guard = requireMembership(c, user.id);
  if ("deny" in guard) return guard.deny;
  const { team, role } = guard.ok;

  const members = listTeamMembers(team.id);
  return c.json({
    team,
    role,
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
  const guard = requireTeamAdmin(c, user.id);
  if ("deny" in guard) return guard.deny;

  const invites = listTeamInvites(guard.ok.team.id);
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
  const guard = requireTeamAdmin(c, user.id);
  if ("deny" in guard) return guard.deny;
  const { team } = guard.ok;

  const body = await parseJsonBody(c);
  if ("deny" in body) return body.deny;

  const parsed = inviteSchema.safeParse(body.ok);
  if (!parsed.success) return c.json({ error: "Invalid email or role." }, 400);

  const invite = createTeamInvite({
    teamId: team.id,
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
        teamName: team.name,
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
  const guard = requireTeamAdmin(c, user.id);
  if ("deny" in guard) return guard.deny;

  const token = c.req.param("token");
  // Scope the revoke to the caller's team — without this, any admin can
  // revoke any invite on any team if they know or guess the token.
  const invite = getTeamInvite(token);
  if (!invite || invite.team_id !== guard.ok.team.id) {
    return c.json({ error: "Invite not found." }, 404);
  }
  revokeTeamInvite(token);
  return c.json({ revoked: true });
});

// ---------------------------------------------------------------------------
// POST /team/accept-invite
// ---------------------------------------------------------------------------

const acceptSchema = z.object({ token: z.string().min(16) });

router.post("/team/accept-invite", async (c) => {
  const user = c.get("user");

  const body = await parseJsonBody(c);
  if ("deny" in body) return body.deny;

  const parsed = acceptSchema.safeParse(body.ok);
  if (!parsed.success) return c.json({ error: "invite token required" }, 400);

  if (getTeamForUser(user.id)) {
    return c.json({ error: "You are already a member of a team." }, 409);
  }

  const membership = acceptTeamInvite(parsed.data.token, user.id);
  if (!membership) return c.json({ error: "invalid or expired invite" }, 400);

  return c.json({ membership });
});

export default router;
