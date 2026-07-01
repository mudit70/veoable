// NestJS basic fixture exercising:
//   - @Controller('users') class prefix
//   - @Get(), @Post(), @Get(':id'), @Patch(':id'), @Delete(':id') methods
//   - @UseGuards class-level + method-level middleware
//   - No-prefix controller (root mount)

const Controller = (_p?: string): ClassDecorator => () => {};
const Get = (_r?: string): MethodDecorator => () => {};
const Post = (_r?: string): MethodDecorator => () => {};
const Patch = (_r?: string): MethodDecorator => () => {};
const Delete = (_r?: string): MethodDecorator => () => {};
const UseGuards = (..._g: unknown[]): ClassDecorator & MethodDecorator => () => {};

class AuthGuard {}
class RoleGuard {}

@Controller('users')
@UseGuards(AuthGuard)
export class UsersController {
  @Get()
  listUsers() {}

  @Get(':id')
  getUser() {}

  @Post()
  @UseGuards(RoleGuard)
  createUser() {}

  @Patch(':id')
  updateUser() {}

  @Delete(':id')
  removeUser() {}
}

@Controller()
export class HealthController {
  @Get('health')
  health() {}
}
