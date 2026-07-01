<?php
// Eloquent model — patterns a framework-eloquent visitor must detect
//
// Detection targets:
//   class Contact extends Model → DatabaseTable("contacts")
//   $fillable → writable columns
//   $casts → column types
//   belongsToMany → FOREIGN_KEY / relationship edge

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

class Contact extends Model
{
    protected $fillable = ['name', 'email', 'phone', 'company'];

    protected $casts = [
        'created_at' => 'datetime',
        'updated_at' => 'datetime',
    ];

    public function tags(): BelongsToMany
    {
        return $this->belongsToMany(Tag::class);
    }
}

class Tag extends Model
{
    protected $fillable = ['name'];

    public function contacts(): BelongsToMany
    {
        return $this->belongsToMany(Contact::class);
    }
}
