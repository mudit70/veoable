package com.example.userapi.controller;

import java.util.List;
import com.example.userapi.model.User;
import com.example.userapi.service.UserService;

public class UserController {
    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    public List<User> listUsers() {
        return userService.getAllUsers();
    }

    public User getUser(Long id) {
        return userService.getUserById(id)
            .orElseThrow(() -> new RuntimeException("User not found"));
    }

    public User createUser(String name, String email) {
        return userService.createUser(name, email);
    }

    public void deleteUser(Long id) {
        userService.deleteUser(id);
    }
}
