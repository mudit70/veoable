// NestJS+TypeORM-style service. Receivers use `Repository<X>`
// type-annotation patterns the visitor must follow to attribute
// calls at `'direct'` confidence.
import { User, Post } from './user.entity.js';

// Stubs so the fixture compiles standalone.
class Repository<T> {
  async find(): Promise<T[]> { return []; }
  async findOne(_opts: unknown): Promise<T | null> { return null; }
  async save(_e: T): Promise<T> { return _e; }
  async delete(_opts: unknown): Promise<unknown> { return {}; }
  async update(_id: unknown, _patch: Partial<T>): Promise<unknown> { return {}; }
}

class EntityManager {
  async find<T>(_e: new () => T): Promise<T[]> { return []; }
  async save<T>(_e: T): Promise<T> { return _e; }
}

function InjectRepository(_e: unknown): ParameterDecorator { return () => {}; }
function InjectEntityManager(): ParameterDecorator { return () => {}; }

export class UsersService {
  constructor(
    // Parameter property — visitor must read `Repository<User>` →
    // table `user`.
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    // Different name (`postRepo`) AND different entity type
    // (`Post`). Confirms the visitor reads the TYPE, not the field
    // name, to pick the entity.
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    // EntityManager pattern — table comes from the call's first arg.
    @InjectEntityManager() private readonly em: EntityManager,
  ) {}

  async listUsers(): Promise<User[]> {
    return this.userRepo.find();
  }

  async getUser(id: number): Promise<User | null> {
    return this.userRepo.findOne({ where: { id } });
  }

  async saveUser(u: User): Promise<User> {
    return this.userRepo.save(u);
  }

  async listPosts(): Promise<Post[]> {
    return this.postRepo.find();
  }

  async deletePost(id: number): Promise<void> {
    await this.postRepo.delete({ id });
  }

  async listFromManager(): Promise<User[]> {
    // EntityManager → first arg is the entity class.
    return this.em.find(User);
  }
}

// Legacy name-heuristic path: bare `userRepository` (no type info).
// Should still resolve to `user` but at `'inferred'` confidence.
declare const userRepository: { find(): Promise<User[]> };

export async function listUsersBare(): Promise<User[]> {
  return userRepository.find();
}
