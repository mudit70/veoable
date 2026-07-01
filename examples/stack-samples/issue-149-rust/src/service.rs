use crate::models::User;
use std::sync::Mutex;

pub struct UserService {
    users: Mutex<Vec<User>>,
}

impl UserService {
    pub fn new() -> Self {
        Self {
            users: Mutex::new(Vec::new()),
        }
    }

    pub fn get_all(&self) -> Vec<User> {
        self.users.lock().unwrap().clone()
    }

    pub fn find_by_id(&self, id: u64) -> Option<User> {
        self.users.lock().unwrap().iter().find(|u| u.id == id).cloned()
    }

    pub fn create(&self, name: String, email: String) -> User {
        let mut users = self.users.lock().unwrap();
        let id = users.len() as u64 + 1;
        let user = User::new(id, name, email);
        users.push(user.clone());
        user
    }

    pub fn delete(&self, id: u64) -> bool {
        let mut users = self.users.lock().unwrap();
        let len = users.len();
        users.retain(|u| u.id != id);
        users.len() < len
    }

    fn generate_id(&self) -> u64 {
        self.users.lock().unwrap().len() as u64 + 1
    }
}
