// TypeORM entity with mixed column kinds. Stub the decorators so the
// fixture compiles without typeorm installed.
function Entity(_opts?: string | { name?: string }): ClassDecorator { return () => {}; }
function PrimaryGeneratedColumn(): PropertyDecorator { return () => {}; }
function Column(_opts?: unknown): PropertyDecorator { return () => {}; }
function CreateDateColumn(): PropertyDecorator { return () => {}; }
function ManyToOne(_target: unknown, _inverse?: unknown): PropertyDecorator { return () => {}; }
function Repository<T>() { return {} as { find: () => Promise<T[]>; findOne: () => Promise<T | null>; save: () => Promise<T>; delete: () => Promise<unknown>; }; }

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar' })
  email!: string;

  @Column()
  name?: string;

  @CreateDateColumn()
  createdAt!: Date;
}

@Entity({ name: 'posts' })
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @ManyToOne(() => User)
  author!: User;
}

// Entity with default table name (lowercase class name).
@Entity()
export class Comment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  body!: string;
}
