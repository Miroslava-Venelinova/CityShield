using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace interfacetest
{
    public class Bulbasaur : IPokemon
    {
        public int hp { get; set; } = 30;

        public void Attack(IPokemon target)
        {
            target.hp -= 5;
        }
    }
}
