import click

@click.group()
def cli():
    pass

@cli.command()
def list_items():
    print("listing")

@cli.command()
@click.argument('item_id')
def get_item(item_id):
    print(f"getting {item_id}")

@cli.command()
def create_item():
    print("creating")

if __name__ == '__main__':
    cli()
