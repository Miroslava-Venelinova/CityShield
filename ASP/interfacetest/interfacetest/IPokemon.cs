using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace interfacetest
{
    public interface IPokemon
    {
        int hp { get; set; }
        void Attack(IPokemon target);
    }
}
