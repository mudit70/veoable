package com.example;

import org.springframework.stereotype.Service;

@Service
public class UserService {
    private UserRepository userRepository;

    public UserService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    public Object getAllUsers() {
        return userRepository.findAll();
    }

    public Object getUser(Long id) {
        return userRepository.findById(id);
    }

    public Object createUser(Object user) {
        return userRepository.save(user);
    }

    public void deleteUser(Long id) {
        userRepository.deleteById(id);
    }

    public Object findByEmail(String email) {
        return userRepository.findByEmail(email);
    }
}
