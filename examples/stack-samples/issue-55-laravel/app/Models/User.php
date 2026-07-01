<?php

namespace App\Models;

class User
{
    public static function all() { return []; }
    public static function find($id) { return null; }
    public static function findOrFail($id) { return new self(); }
    public static function create(array $data) { return new self(); }
    public static function destroy($id) {}
    public static function where($col, $val) { return new self(); }
    public function update(array $data) { return $this; }
    public function delete() {}
    public function get() { return []; }
}
