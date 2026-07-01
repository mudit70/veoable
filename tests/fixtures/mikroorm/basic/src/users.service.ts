import { User } from './user.entity.js';

class EntityRepository<T> {
  async find(): Promise<T[]> { return []; }
  async findOne(_w: unknown): Promise<T | null> { return null; }
  async persist(_e: T): Promise<void> {}
  async remove(_e: T): Promise<void> {}
}
class EntityManager {
  async find<T>(_e: new () => T): Promise<T[]> { return []; }
  async persist<T>(_e: T): Promise<void> {}
}
function InjectRepository(_e: unknown): ParameterDecorator { return () => {}; }

export class UsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: EntityRepository<User>,
    private readonly em: EntityManager,
  ) {}

  async listUsers(): Promise<User[]> { return this.userRepo.find(); }
  async getUser(): Promise<User | null> { return this.userRepo.findOne({}); }
  async addUser(u: User): Promise<void> { return this.userRepo.persist(u); }
  async removeUser(u: User): Promise<void> { return this.userRepo.remove(u); }
  async listViaEm(): Promise<User[]> { return this.em.find(User); }
}
