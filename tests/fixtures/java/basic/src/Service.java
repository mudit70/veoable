package basic;

import java.util.List;
import java.util.ArrayList;

public interface Repository {
    List<String> findAll();
    String findById(String id);
}

class UserServiceImpl implements Repository {
    private List<String> users = new ArrayList<>();

    public UserServiceImpl() {
        users.add("Alice");
        users.add("Bob");
    }

    @Override
    public List<String> findAll() {
        return users;
    }

    @Override
    public String findById(String id) {
        return users.stream()
            .filter(u -> u.equals(id))
            .findFirst()
            .orElse(null);
    }

    public void addUser(String name) {
        users.add(name);
    }

    // Package-private method
    void internalProcess() {}
}
