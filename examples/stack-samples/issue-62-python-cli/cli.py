import click
import httpx

@click.group()
def cli():
    """User management CLI"""
    pass

@cli.command()
def list_users():
    """List all users"""
    response = httpx.get("http://localhost:8000/api/users")
    click.echo(response.json())

@cli.command()
@click.argument('user_id')
def get_user(user_id):
    """Get a specific user"""
    response = httpx.get(f"http://localhost:8000/api/users/{user_id}")
    click.echo(response.json())

@cli.command()
@click.option('--name', required=True)
@click.option('--email', required=True)
def create_user(name, email):
    """Create a new user"""
    response = httpx.post("http://localhost:8000/api/users", json={"name": name, "email": email})
    click.echo(response.json())

if __name__ == '__main__':
    cli()
