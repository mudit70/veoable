import { User, Photo, Person } from './user.model.js';

export async function listUsers() { return User.findAll(); }
export async function getUser(id: number) { return User.findByPk(id); }
export async function createUser(email: string) { return User.create({ email }); }
export async function updateUser(id: number, name: string) { return User.update({ name }, { where: { id } }); }
export async function destroyUser(id: number) { return User.destroy({ where: { id } }); }
export async function countPhotos() { return Photo.count(); }
export async function listPeople() { return Person.findAll(); }
