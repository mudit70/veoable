// Struct with impl block
pub struct UserService {
    name: String,
}

impl UserService {
    // Constructor — pub
    pub fn new(name: String) -> Self {
        Self { name }
    }

    // Public method
    pub fn get_all(&self) -> Vec<String> {
        vec!["Alice".to_string(), "Bob".to_string()]
    }

    // Method with params
    pub fn find_by_id(&self, id: u64) -> Option<String> {
        if id == 1 { Some("Alice".to_string()) } else { None }
    }

    // Private method
    fn internal_process(&self) {}

    // Async method
    pub async fn fetch_remote(&self) -> String {
        "remote data".to_string()
    }

    // Forward reference: calls internal_process defined above
    pub fn do_work(&self) {
        self.internal_process();
    }
}

// Trait definition
pub trait Repository {
    fn find_all(&self) -> Vec<String>;
    fn find_by_id(&self, id: u64) -> Option<String>;
}

// Trait implementation
impl Repository for UserService {
    fn find_all(&self) -> Vec<String> {
        self.get_all()
    }

    fn find_by_id(&self, id: u64) -> Option<String> {
        UserService::find_by_id(self, id)
    }
}
