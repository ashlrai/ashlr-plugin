// AST test fixture — sample TypeScript with classes, functions, interfaces, type aliases.

export interface UserProfile {
  id: string;
  name: string;
  email: string;
}

export type UserId = string;

export class UserService {
  private users: Map<UserId, UserProfile>;

  constructor() {
    this.users = new Map();
  }

  addUser(profile: UserProfile): void {
    this.users.set(profile.id, profile);
  }

  getUser(id: UserId): UserProfile | undefined {
    return this.users.get(id);
  }

  deleteUser(id: UserId): boolean {
    return this.users.delete(id);
  }
}

export function createUser(name: string, email: string): UserProfile {
  const id = `user-${Date.now()}`;
  return { id, name, email };
}

const defaultAdmin: UserProfile = {
  id: "admin-0",
  name: "Admin",
  email: "admin@example.com",
};

export { defaultAdmin };
