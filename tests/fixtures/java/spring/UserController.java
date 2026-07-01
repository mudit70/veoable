package com.example;

import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/api/users")
public class UserController {
    @GetMapping
    public List<String> list() { return List.of(); }

    @GetMapping("/{id}")
    public String get(@PathVariable Long id) { return ""; }

    @PostMapping
    public String create(@RequestBody String name) { return ""; }

    @PutMapping("/{id}")
    public String update(@PathVariable Long id) { return ""; }

    @DeleteMapping("/{id}")
    public void delete(@PathVariable Long id) {}

    @PatchMapping("/{id}")
    public String patch(@PathVariable Long id) { return ""; }
}
